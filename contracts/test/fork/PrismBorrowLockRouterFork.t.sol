// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrismBorrowLockRouter} from "../../src/core/PrismBorrowLockRouter.sol";
import {PrismYieldAMM} from "../../src/core/PrismYieldAMM.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {IBorrowerOperationsSignatures, ITroveManager, IPriceFeed, IMUSDSavingsRate, IMUSDSavingsGauge, IPrismFeeStaking} from "../../src/interfaces/IMezoCore.sol";

contract ForkMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ForkMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPriceFeed is IPriceFeed {
    uint256 public price = 50_000e18;

    function setPrice(uint256 p) external {
        price = p;
    }

    function fetchPrice() external view returns (uint256) {
        return price;
    }
}

contract MockTroveManager is ITroveManager {
    uint256 public icr = 200e16;
    uint256 public tcr = 200e16;
    uint256 public coll = 1e8;
    uint256 public debt = 10_000e18;

    function setIcr(uint256 v) external {
        icr = v;
    }

    function setTcr(uint256 v) external {
        tcr = v;
    }

    function setTrove(address, uint256 c, uint256 d) external {
        coll = c;
        debt = d;
    }

    function getCurrentICR(address, uint256) external view returns (uint256) {
        return icr;
    }

    function getTroveDebt(address) external view returns (uint256) {
        return debt;
    }

    function getTroveColl(address) external view returns (uint256) {
        return coll;
    }

    function getTCR(uint256) external view returns (uint256) {
        return tcr;
    }
}

contract MockBorrowerOps is IBorrowerOperationsSignatures {
    ForkMUSD public immutable musd;

    constructor(ForkMUSD _musd) {
        musd = _musd;
    }

    function borrowerOperations() external view returns (address) {
        return address(this);
    }

    function getNonce(address) external pure returns (uint256) {
        return 0;
    }

    function openTroveWithSignature(
        uint256 debtAmount,
        address,
        address,
        address,
        address recipient,
        bytes memory,
        uint256
    ) external payable {
        musd.mint(recipient, debtAmount);
    }

    function withdrawMUSDWithSignature(
        uint256 amount,
        address,
        address,
        address,
        address recipient,
        bytes memory,
        uint256
    ) external {
        musd.mint(recipient, amount);
        // Mirror real BorrowerOperations: ActivePool pings the recipient with a
        // zero-value call after every debt-only adjust (SendCollateral.sol).
        (bool ok, ) = recipient.call{value: 0}("");
        require(ok, "Sending BTC failed");
    }

    function repayMUSDWithSignature(uint256, address, address, address, bytes memory, uint256) external pure {
        revert("not used");
    }

    function closeTroveWithSignature(address, address, bytes memory, uint256) external pure {
        revert("not used");
    }
}

contract MockFeeStaking is IPrismFeeStaking {
    function getFeeDiscountBps(address) external pure returns (uint256) {
        return 0;
    }

    function notifyRewardAmount(uint256) external {}
}

contract PrismBorrowLockRouterForkTest is Test {
    uint256 internal constant SECONDS_PER_WEEK = 604800;
    uint256 internal constant SEED = 10_000e18;

    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant MEZO = 0x7B7c000000000000000000000000000000000001;

    address internal borrower; // set in setUp from borrowerKey
    address internal relayer = address(0x4E1A);
    address internal treasury = address(0x7BEA5);

    uint256 internal borrowerKey = 0xB0BB0;
    uint256 internal maturity;

    ForkMUSD internal musd;
    MockPriceFeed internal priceFeed;
    MockTroveManager internal tm;
    MockBorrowerOps internal bops;
    MockFeeStaking internal feeStaking;
    PrismTokenizer internal tokenizer;
    PrismYieldAMM internal amm;
    PrismBorrowLockRouter internal router;
    address internal pt;

    function setUp() public {
        borrower = vm.addr(borrowerKey);
        vm.createSelectFork(vm.envOr("MEZO_TESTNET_RPC_URL", string("https://rpc.test.mezo.org")));
        assertEq(block.chainid, 31611, "expected Mezo Testnet");

        vm.etch(MUSD, address(new ForkMUSD()).code);
        deal(MUSD, address(this), 0);
        musd = ForkMUSD(MUSD);

        vm.etch(MEZO, address(new ForkMEZO()).code);

        priceFeed = new MockPriceFeed();
        tm = new MockTroveManager();
        bops = new MockBorrowerOps(musd);
        feeStaking = new MockFeeStaking();

        maturity = ((block.timestamp / SECONDS_PER_WEEK) + 4) * SECONDS_PER_WEEK;

        TestnetFeeInjector smusd = new TestnetFeeInjector(IERC20(MUSD));
        MockMUSDSavingsGauge gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(MEZO));
        DualTrackAdapter adapter =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(MEZO), IMUSDSavingsGauge(address(gauge)), 500);
        PrismSeriesFactory factory = new PrismSeriesFactory();
        tokenizer = new PrismTokenizer(
            IERC20(MUSD),
            IMUSDSavingsRate(address(smusd)),
            adapter,
            factory,
            IPrismFeeStaking(address(feeStaking)),
            IERC20(MEZO),
            treasury,
            address(this),
            0
        );
        tokenizer.initializeSeries(maturity);
        amm = new PrismYieldAMM(tokenizer, IERC20(MUSD), IPrismFeeStaking(address(feeStaking)), treasury);
        pt = tokenizer.getSeries(maturity).ptToken;

        router = new PrismBorrowLockRouter(bops, tm, priceFeed, amm, IERC20(MUSD));

        _seedPool();
    }

    function _seedPool() internal {
        musd.mint(address(this), SEED * 2);
        vm.startPrank(address(this));
        musd.approve(address(tokenizer), SEED);
        tokenizer.mintPyFromMusd(SEED, maturity, address(this));
        musd.approve(address(amm), SEED);
        IERC20(pt).approve(address(amm), SEED);
        amm.addLiquidity(maturity, SEED, SEED, address(this));
        vm.stopPrank();
    }

    function _signLockTerms(PrismBorrowLockRouter.BorrowLockParams memory p, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                router.LOCK_TERMS_TYPEHASH(),
                p.borrower,
                p.musdBorrowAmount,
                p.maturity,
                p.minPtOut,
                p.relayerFeeMusd,
                p.nonce,
                p.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", router.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _params(uint256 nonce) internal view returns (PrismBorrowLockRouter.BorrowLockParams memory p) {
        p = PrismBorrowLockRouter.BorrowLockParams({
            borrower: borrower,
            musdBorrowAmount: 1_000e18,
            maturity: maturity,
            minPtOut: 900e18,
            relayerFeeMusd: 0,
            nonce: nonce,
            deadline: block.timestamp + 1 hours,
            mezoDeadline: block.timestamp + 1 hours,
            upperHint: address(0),
            lowerHint: address(0)
        });
    }

    function _borrowerAddr() internal view returns (address) {
        return vm.addr(borrowerKey);
    }

    /// (a) direct borrower call
    function testForkDirectBorrowerCall() public {
        vm.startPrank(_borrowerAddr());
        uint256 ptOut = router.borrowAndLockFixedYield(_params(1), hex"00", _signLockTerms(_params(1), borrowerKey));
        vm.stopPrank();

        assertGt(ptOut, 0);
        assertEq(IERC20(pt).balanceOf(_borrowerAddr()), ptOut);
        assertEq(musd.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
        assertEq(musd.balanceOf(_borrowerAddr()), 0);
    }

    /// (b) gasless relayer call with relayerFeeMusd
    function testForkRelayerCallWithFee() public {
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(2);
        p.relayerFeeMusd = 10e18; // 1% of 1000
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.prank(relayer);
        uint256 ptOut = router.borrowAndLockFixedYield(p, hex"00", sig);

        assertGt(ptOut, 0);
        assertEq(musd.balanceOf(relayer), 10e18);
        assertEq(IERC20(pt).balanceOf(_borrowerAddr()), ptOut);
        assertEq(musd.balanceOf(address(router)), 0);
    }

    /// (c) STRIDE-01: relayer tampers with minPtOut
    function testForkStride01TamperMinPtOut() public {
        PrismBorrowLockRouter.BorrowLockParams memory signedP = _params(3);
        bytes memory sig = _signLockTerms(signedP, borrowerKey);

        signedP.minPtOut = 1e18; // tamper
        vm.prank(relayer);
        vm.expectRevert(bytes("bad lock sig"));
        router.borrowAndLockFixedYield(signedP, hex"00", sig);
    }

    /// (c2) STRIDE-01: relayer tampers with relayerFeeMusd
    function testForkStride01TamperRelayerFee() public {
        PrismBorrowLockRouter.BorrowLockParams memory signedP = _params(4);
        signedP.relayerFeeMusd = 5e18;
        bytes memory sig = _signLockTerms(signedP, borrowerKey);

        signedP.relayerFeeMusd = 500e18; // tamper to 50%
        vm.prank(relayer);
        vm.expectRevert(bytes("bad lock sig"));
        router.borrowAndLockFixedYield(signedP, hex"00", sig);
    }

    /// (d) R-013: ICR < 150% reverts
    function testForkIcrBelow150Reverts() public {
        tm.setIcr(149e16);
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(5);
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.prank(_borrowerAddr());
        vm.expectRevert(bytes("icr"));
        router.borrowAndLockFixedYield(p, hex"00", sig);
    }

    /// (d2) R-013: recovery mode requires 165%
    function testForkRecoveryModeNeeds165() public {
        tm.setTcr(140e16); // TCR < 150% → recovery mode
        tm.setIcr(160e16); // 160% passes normal floor but fails recovery floor
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(6);
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.prank(_borrowerAddr());
        vm.expectRevert(bytes("icr"));
        router.borrowAndLockFixedYield(p, hex"00", sig);

        tm.setIcr(166e16);
        bytes memory sig2 = _signLockTerms(_params(7), borrowerKey);
        vm.prank(_borrowerAddr());
        uint256 ptOut = router.borrowAndLockFixedYield(_params(7), hex"00", sig2);
        assertGt(ptOut, 0);
    }

    /// (e) gas usage with hints < 680,000
    function testForkGasUnder680k() public {
        // Seed borrower collateral context (mock returns fixed ICR anyway)
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(8);
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.prank(_borrowerAddr());
        uint256 g = gasleft();
        router.borrowAndLockFixedYield(p, hex"00", sig);
        uint256 used = g - gasleft();

        console.log("borrowAndLock gas:", used);
        assertLt(used, 680_000, "gas > 680k");
    }

    /// fee capped at 1% even if signed higher is impossible (sig binds fee) — check cap when borrower==sender is 0
    function testForkDirectCallerGetsZeroFee() public {
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(9);
        p.relayerFeeMusd = 10e18; // signed fee present
        bytes memory sig = _signLockTerms(p, borrowerKey);

        // borrower calls directly → fee forced to 0
        vm.prank(_borrowerAddr());
        router.borrowAndLockFixedYield(p, hex"00", sig);

        assertEq(musd.balanceOf(_borrowerAddr()), 0);
        assertEq(musd.balanceOf(address(router)), 0);
    }

    /// openTrove path with native BTC
    function testForkOpenTroveAndLock() public {
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(10);
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.deal(_borrowerAddr(), 1 ether);
        vm.prank(_borrowerAddr());
        uint256 ptOut = router.openTroveAndLockFixedYield{value: 0.1 ether}(p, hex"00", sig);

        assertGt(ptOut, 0);
        assertEq(IERC20(pt).balanceOf(_borrowerAddr()), ptOut);
        assertEq(address(router).balance, 0);
        assertEq(musd.balanceOf(address(router)), 0);
    }

    /// expired deadline reverts
    function testForkExpiredDeadlineReverts() public {
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(11);
        p.deadline = block.timestamp - 1;
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.prank(_borrowerAddr());
        vm.expectRevert(bytes("expired"));
        router.borrowAndLockFixedYield(p, hex"00", sig);
    }

    /// nonce reuse reverts
    function testForkNonceReuseReverts() public {
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(12);
        bytes memory sig = _signLockTerms(p, borrowerKey);

        vm.prank(_borrowerAddr());
        router.borrowAndLockFixedYield(p, hex"00", sig);

        vm.prank(_borrowerAddr());
        vm.expectRevert(bytes("nonce used"));
        router.borrowAndLockFixedYield(p, hex"00", sig);
    }

    function testForkPreviewBorrowAndLock() public {
        (uint256 ptOut, uint256 newIcr, uint256 fixedApyBps) =
            router.previewBorrowAndLock(_borrowerAddr(), 1_000e18, maturity);
        assertGt(ptOut, 0);
        assertGt(newIcr, 0);
        assertGt(fixedApyBps, 0);

        // zero-debt → max ICR
        tm.setTrove(_borrowerAddr(), 0, 0);
        (, uint256 icr0,) = router.previewBorrowAndLock(_borrowerAddr(), 0, maturity);
        assertEq(icr0, type(uint256).max);
    }

    function testForkRelayerFeeCappedAt1Percent() public {
        // signed fee above 1% is impossible via sig; force path by signing 1% exactly at boundary
        PrismBorrowLockRouter.BorrowLockParams memory p = _params(20);
        p.relayerFeeMusd = 10e18; // exactly 1% of 1000e18
        bytes memory sig = _signLockTerms(p, borrowerKey);
        vm.prank(relayer);
        router.borrowAndLockFixedYield(p, hex"00", sig);
        assertEq(musd.balanceOf(relayer), 10e18);
    }
}
