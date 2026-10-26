// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PrismTokenizer} from "../../src/core/PrismTokenizer.sol";
import {PrismYieldAMM} from "../../src/core/PrismYieldAMM.sol";
import {PrismFeeStaking} from "../../src/core/PrismFeeStaking.sol";
import {DualTrackAdapter} from "../../src/core/DualTrackAdapter.sol";
import {PrismSeriesFactory} from "../../src/core/tokens/PrismSeriesFactory.sol";
import {TestnetFeeInjector} from "../../src/mocks/TestnetFeeInjector.sol";
import {MockMUSDSavingsGauge} from "../../src/mocks/MockMUSDSavingsGauge.sol";
import {IMUSDSavingsRate, IMUSDSavingsGauge, IPrismFeeStaking} from "../../src/interfaces/IMezoCore.sol";

contract InvariantMUSD is ERC20 {
    constructor() ERC20("MUSD", "MUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract InvariantMEZO is ERC20 {
    constructor() ERC20("MEZO", "MEZO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PrismInvariantHandler {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    PrismTokenizer public tokenizer;
    PrismYieldAMM public amm;
    PrismFeeStaking public feeStaking;
    TestnetFeeInjector public injector;
    IERC20 public musd;
    IERC20 public mezo;
    IERC20 public smusd;
    uint256[] public maturities;
    address[] public actors;
    address public holder;
    bool public initialized;

    function initialize(
        PrismTokenizer _tokenizer,
        PrismYieldAMM _amm,
        PrismFeeStaking _feeStaking,
        TestnetFeeInjector _injector,
        IERC20 _musd,
        IERC20 _mezo,
        IERC20 _smusd,
        uint256[] memory _maturities,
        address[] memory _actors
    ) external {
        require(!initialized, "initialized");
        tokenizer = _tokenizer;
        amm = _amm;
        feeStaking = _feeStaking;
        injector = _injector;
        musd = _musd;
        mezo = _mezo;
        smusd = _smusd;
        maturities = _maturities;
        actors = _actors;
        holder = msg.sender;
        initialized = true;
    }

    function holders() external view returns (address[] memory result) {
        result = new address[](actors.length + 1);
        for (uint256 i; i < actors.length; ++i) {
            result[i] = actors[i];
        }
        result[actors.length] = holder;
    }

    function mintPy(uint256 actorSeed, uint256 seriesSeed, uint256 amountSeed) external {
        address actor = _actor(actorSeed);
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp >= maturity) return;
        uint256 amount = _amount(amountSeed, 1_000e18);
        uint256 balance = musd.balanceOf(actor);
        if (amount > balance) amount = balance;
        if (amount == 0) return;
        vm.prank(actor);
        tokenizer.mintPyFromMusd(amount, maturity, actor);
    }

    function redeemPy(uint256 actorSeed, uint256 seriesSeed, uint256 amountSeed) external {
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp >= maturity) return;
        (address actor, uint256 balance) = _actorWithPy(maturity, actorSeed);
        if (balance == 0) return;
        uint256 amount = 1 + (amountSeed % balance);
        vm.prank(actor);
        tokenizer.redeemPyBeforeMaturity(amount, maturity, actor);
    }

    function redeemPtAfterMaturity(uint256 actorSeed, uint256 seriesSeed, uint256 amountSeed) external {
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp < maturity) return;
        (address actor, uint256 balance) = _actorWithPt(maturity, actorSeed);
        if (balance == 0) return;
        uint256 amount = 1 + (amountSeed % balance);
        vm.prank(actor);
        tokenizer.redeemPtAfterMaturity(amount, maturity, actor);
    }

    function claimYield(uint256 actorSeed, uint256 seriesSeed) external {
        address actor = _actor(actorSeed);
        uint256 maturity = _maturity(seriesSeed);
        vm.prank(actor);
        tokenizer.claimYield(maturity, actor);
    }

    function swapMusdForPt(uint256 actorSeed, uint256 seriesSeed, uint256 amountSeed) external {
        address actor = _actor(actorSeed);
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp >= maturity) return;
        (,,, uint256 reservePt,,, uint256 price) = amm.getPool(maturity);
        uint256 amount = _amount(amountSeed, 1_000e18);
        uint256 maxIn = (reservePt * price) / 1e18 / 2;
        if (amount > maxIn) amount = maxIn;
        uint256 balance = musd.balanceOf(actor);
        if (amount > balance) amount = balance;
        if (amount == 0) return;
        vm.prank(actor);
        amm.swapExactMusdForPt(maturity, amount, 0, actor);
    }

    function swapPtForMusd(uint256 actorSeed, uint256 seriesSeed, uint256 amountSeed) external {
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp >= maturity) return;
        (address actor, uint256 balance) = _actorWithPt(maturity, actorSeed);
        if (balance == 0) return;
        (,, uint256 reserveMusd,,,, uint256 price) = amm.getPool(maturity);
        uint256 maxIn = ((reserveMusd * 1e18) / price) / 2;
        uint256 amount = 1 + (amountSeed % balance);
        if (amount > maxIn) amount = maxIn;
        if (amount == 0) return;
        vm.prank(actor);
        amm.swapExactPtForMusd(maturity, amount, 0, actor);
    }

    function swapMusdForYt(uint256 actorSeed, uint256 seriesSeed, uint256 amountSeed) external {
        address actor = _actor(actorSeed);
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp >= maturity) return;
        (,, uint256 reserveMusd,,,, uint256 price) = amm.getPool(maturity);
        uint256 amount = _amount(amountSeed, 100e18);
        uint256 maxIn = ((reserveMusd * 1e18) / price) / 2;
        if (amount > maxIn) amount = maxIn;
        uint256 balance = musd.balanceOf(actor);
        if (amount > balance) amount = balance;
        if (amount == 0) return;
        vm.prank(actor);
        amm.swapExactMusdForYt(maturity, amount, 0, actor);
    }

    function injectWeeklyFeeYield(uint256 amountSeed) external {
        uint256 supply = injector.totalSupply();
        if (supply == 0) return;
        if (injector.lastInjection() != 0 && block.timestamp < injector.lastInjection() + injector.INJECTION_COOLDOWN())
        {
            return;
        }
        uint256 amount = _amount(amountSeed, 10e18);
        uint256 maxAmount = (supply * injector.MAX_FEE_BPS()) / injector.FEE_BPS_DENOMINATOR();
        if (amount > maxAmount) amount = maxAmount;
        uint256 balance = musd.balanceOf(actors[0]);
        if (amount > balance) amount = balance;
        if (amount == 0) return;
        vm.prank(actors[0]);
        injector.injectWeeklyFeeYield(amount);
    }

    function evaluateAndSwitchMode(uint256 gaugeAprSeed, uint256 unstakedAprSeed) external {
        uint256 gaugeApr = gaugeAprSeed % 3_000;
        uint256 unstakedApr = unstakedAprSeed % 3_000;
        tokenizer.updateTrackAprs(gaugeApr, unstakedApr);
        tokenizer.evaluateTrackMode();
    }

    function stakeMezo(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _actor(actorSeed);
        uint256 amount = _amount(amountSeed, 500e18);
        uint256 balance = mezo.balanceOf(actor);
        if (amount > balance) amount = balance;
        if (amount == 0) return;
        vm.prank(actor);
        feeStaking.stake(amount);
    }

    function unstakeMezo(uint256 actorSeed, uint256 amountSeed) external {
        (address actor, uint256 balance) = _actorWithStake(actorSeed);
        if (balance == 0) return;
        uint256 amount = 1 + (amountSeed % balance);
        vm.prank(actor);
        feeStaking.unstake(amount);
    }

    function warpTime(uint256 secondsSeed) external {
        uint256 delta = 1 hours + (secondsSeed % 30 days);
        vm.warp(block.timestamp + delta);
    }

    function warpPastMaturity(uint256 seriesSeed) external {
        uint256 maturity = _maturity(seriesSeed);
        if (block.timestamp <= maturity) {
            vm.warp(maturity + 1 hours);
        } else {
            vm.warp(block.timestamp + 1 hours);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _maturity(uint256 seed) internal view returns (uint256) {
        return maturities[seed % maturities.length];
    }

    function _actorWithPt(uint256 maturity, uint256 seed) internal view returns (address actor, uint256 balance) {
        address ptToken = tokenizer.getSeries(maturity).ptToken;
        for (uint256 i; i < actors.length; ++i) {
            address candidate = actors[(seed % actors.length + i) % actors.length];
            uint256 candidateBalance = IERC20(ptToken).balanceOf(candidate);
            if (candidateBalance > balance) {
                actor = candidate;
                balance = candidateBalance;
            }
        }
    }

    function _actorWithStake(uint256 seed) internal view returns (address actor, uint256 balance) {
        for (uint256 i; i < actors.length; ++i) {
            address candidate = actors[(seed % actors.length + i) % actors.length];
            (uint128 amount,,,) = feeStaking.stakes(candidate);
            if (amount > balance) {
                actor = candidate;
                balance = amount;
            }
        }
    }

    function _actorWithPy(uint256 maturity, uint256 seed) internal view returns (address actor, uint256 balance) {
        PrismTokenizer.Series memory series = tokenizer.getSeries(maturity);
        for (uint256 i; i < actors.length; ++i) {
            address candidate = actors[(seed % actors.length + i) % actors.length];
            uint256 ptBalance = IERC20(series.ptToken).balanceOf(candidate);
            uint256 ytBalance = IERC20(series.ytToken).balanceOf(candidate);
            uint256 candidateBalance = ptBalance < ytBalance ? ptBalance : ytBalance;
            if (candidateBalance > balance) {
                actor = candidate;
                balance = candidateBalance;
            }
        }
    }

    function _amount(uint256 seed, uint256 maxAmount) internal pure returns (uint256) {
        return 1e18 + (seed % maxAmount);
    }
}

contract PrismCoreInvariantsTest is Test {
    uint256 internal constant WEEK = 604800;
    uint256 internal constant ACTOR_COUNT = 5;
    uint256 internal constant ACTOR_MUSD = 5_000_000e18;
    uint256 internal constant ACTOR_MEZO = 1_000_000e18;
    uint256 internal constant SEED = 500e18;

    InvariantMUSD internal musd;
    InvariantMEZO internal mezo;
    TestnetFeeInjector internal smusd;
    MockMUSDSavingsGauge internal gauge;
    PrismFeeStaking internal feeStaking;
    DualTrackAdapter internal adapter;
    PrismSeriesFactory internal factory;
    PrismTokenizer internal tokenizer;
    PrismYieldAMM internal amm;
    PrismInvariantHandler internal handler;

    address[] internal actors;
    uint256[] internal maturities;
    address internal treasury = address(0x7BEA5);

    function setUp() public {
        musd = new InvariantMUSD();
        mezo = new InvariantMEZO();
        smusd = new TestnetFeeInjector(IERC20(address(musd)));
        gauge = new MockMUSDSavingsGauge(IERC20(address(smusd)), IERC20(address(mezo)));
        feeStaking = new PrismFeeStaking(IERC20(address(mezo)), IERC20(address(musd)));
        adapter =
            new DualTrackAdapter(IERC20(address(smusd)), IERC20(address(mezo)), IMUSDSavingsGauge(address(gauge)), 500);
        factory = new PrismSeriesFactory();
        handler = new PrismInvariantHandler();

        tokenizer = new PrismTokenizer(
            IERC20(address(musd)),
            IMUSDSavingsRate(address(smusd)),
            adapter,
            factory,
            IPrismFeeStaking(address(feeStaking)),
            IERC20(address(mezo)),
            treasury,
            address(handler)
        );
        amm = new PrismYieldAMM(tokenizer, IERC20(address(musd)), IPrismFeeStaking(address(feeStaking)), treasury);

        uint256 currentWeek = block.timestamp / WEEK;
        maturities.push((currentWeek + 4) * WEEK);
        maturities.push((currentWeek + 12) * WEEK);
        tokenizer.initializeSeries(maturities[0]);
        tokenizer.initializeSeries(maturities[1]);

        for (uint256 i; i < ACTOR_COUNT; ++i) {
            address actor = address(uint160(0xA000 + i));
            actors.push(actor);
            musd.mint(actor, ACTOR_MUSD);
            mezo.mint(actor, ACTOR_MEZO);
            vm.startPrank(actor);
            musd.approve(address(tokenizer), type(uint256).max);
            musd.approve(address(amm), type(uint256).max);
            musd.approve(address(smusd), type(uint256).max);
            mezo.approve(address(feeStaking), type(uint256).max);
            for (uint256 j; j < maturities.length; ++j) {
                IERC20(tokenizer.getSeries(maturities[j]).ptToken).approve(address(amm), type(uint256).max);
            }
            vm.stopPrank();
        }

        handler.initialize(
            tokenizer,
            amm,
            feeStaking,
            smusd,
            IERC20(address(musd)),
            IERC20(address(mezo)),
            IERC20(address(smusd)),
            maturities,
            actors
        );

        musd.mint(address(this), SEED * 4);
        vm.startPrank(address(this));
        for (uint256 i; i < maturities.length; ++i) {
            musd.approve(address(tokenizer), SEED);
            tokenizer.mintPyFromMusd(SEED, maturities[i], address(this));
            PrismTokenizer.Series memory series = tokenizer.getSeries(maturities[i]);
            IERC20(series.ptToken).approve(address(amm), SEED);
            musd.approve(address(amm), SEED);
            amm.addLiquidity(maturities[i], SEED, SEED, address(this));
        }
        vm.stopPrank();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = PrismInvariantHandler.mintPy.selector;
        selectors[1] = PrismInvariantHandler.redeemPy.selector;
        selectors[2] = PrismInvariantHandler.redeemPtAfterMaturity.selector;
        selectors[3] = PrismInvariantHandler.claimYield.selector;
        selectors[4] = PrismInvariantHandler.swapMusdForPt.selector;
        selectors[5] = PrismInvariantHandler.swapPtForMusd.selector;
        selectors[6] = PrismInvariantHandler.swapMusdForYt.selector;
        selectors[7] = PrismInvariantHandler.injectWeeklyFeeYield.selector;
        selectors[8] = PrismInvariantHandler.evaluateAndSwitchMode.selector;
        selectors[9] = PrismInvariantHandler.stakeMezo.selector;
        selectors[10] = PrismInvariantHandler.unstakeMezo.selector;
        selectors[11] = PrismInvariantHandler.warpTime.selector;
        selectors[12] = PrismInvariantHandler.warpPastMaturity.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_adapterSolvencyCoversAllPtAndYield() public view {
        uint256 assets =
            adapter.totalSmusdControlled() + musd.balanceOf(address(tokenizer)) + musd.balanceOf(address(adapter));
        uint256 liabilities;
        address[] memory holders = handler.holders();

        for (uint256 i; i < maturities.length; ++i) {
            uint256 maturity = maturities[i];
            PrismTokenizer.Series memory series = tokenizer.getSeries(maturity);
            liabilities += series.totalPt;
            for (uint256 j; j < holders.length; ++j) {
                (uint256 pendingMusd,) = tokenizer.pendingYield(maturity, holders[j]);
                liabilities += pendingMusd;
            }
        }

        assertGe(assets, liabilities, "adapter does not cover PT par + pending YT yield");
    }

    function invariant_ptEqualsYtSupplyBeforeMaturity() public view {
        for (uint256 i; i < maturities.length; ++i) {
            uint256 maturity = maturities[i];
            if (block.timestamp >= maturity) continue;
            PrismTokenizer.Series memory series = tokenizer.getSeries(maturity);
            assertEq(
                IERC20(series.ptToken).totalSupply(), IERC20(series.ytToken).totalSupply(), "PT/YT supply mismatch"
            );
        }
    }

    function invariant_smoothedRateNeverExceedsSpotRate() public view {
        assertLe(tokenizer.smoothedExchangeRate(), 1e18 + smusd.yieldIndex(), "smoothed rate exceeds spot");
    }

    function invariant_feeStakingBalanceMatchesStakes() public view {
        assertGe(
            mezo.balanceOf(address(feeStaking)), feeStaking.totalMezoStaked(), "fee staking MEZO balance below stakes"
        );
    }
}
