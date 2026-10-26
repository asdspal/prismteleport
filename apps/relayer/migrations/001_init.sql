-- PostgreSQL 16 Schema for PrismTeleport Off-Chain Indexer, Relayer & Analytics
-- Requirement Traceability: R-001, R-004, R-007, R-009, R-010, R-017, R-019

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Indexed PT/YT Series & Yield Snapshots (R-001, R-002, R-003, R-004, R-005)
CREATE TABLE prism_series (
    series_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id INTEGER NOT NULL CHECK (chain_id IN (31611, 31612)),
    maturity_timestamp BIGINT NOT NULL CHECK (maturity_timestamp > 0),
    tokenizer_address VARCHAR(42) NOT NULL,
    amm_address VARCHAR(42) NOT NULL,
    pt_token_address VARCHAR(42) NOT NULL,
    yt_token_address VARCHAR(42) NOT NULL,
    initial_smusd_rate NUMERIC(38, 18) NOT NULL,
    smoothed_smusd_rate NUMERIC(38, 18) NOT NULL,
    fixed_apy_bps INTEGER NOT NULL DEFAULT 0,
    implied_yt_apy_bps INTEGER NOT NULL DEFAULT 0,
    active_adapter_mode VARCHAR(24) NOT NULL CHECK (active_adapter_mode IN ('UNSTAKED_SMUSD', 'GAUGE_STAKED_MEZO')),
    total_smusd_locked NUMERIC(38, 18) NOT NULL DEFAULT 0,
    is_matured BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chain_id, maturity_timestamp)
);

CREATE INDEX idx_prism_series_chain_maturity ON prism_series (chain_id, maturity_timestamp);

-- 2. Historical Yield & Regime Switch Snapshots (R-004, R-016)
CREATE TABLE yield_snapshots (
    snapshot_id BIGSERIAL PRIMARY KEY,
    series_id UUID NOT NULL REFERENCES prism_series(series_id) ON DELETE CASCADE,
    block_number BIGINT NOT NULL,
    unstaked_fee_apr_bps INTEGER NOT NULL,
    gauge_mezo_apr_bps INTEGER NOT NULL,
    fixed_pt_apr_bps INTEGER NOT NULL,
    mezo_twap_usd NUMERIC(20, 8) NOT NULL,
    adapter_mode VARCHAR(24) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_yield_snapshots_series_time ON yield_snapshots (series_id, recorded_at DESC);

-- 3. Cross-Chain Teleport Intents (R-007, R-008, R-009, R-011, R-021)
CREATE TABLE teleport_intents (
    intent_hash VARCHAR(66) PRIMARY KEY,
    user_address VARCHAR(42) NOT NULL,
    source_chain_id INTEGER NOT NULL CHECK (source_chain_id IN (1, 11155111, 8453, 84532, 31611, 31612)),
    dest_chain_id INTEGER NOT NULL CHECK (dest_chain_id IN (8453, 84532, 31611, 31612)),
    intent_type VARCHAR(32) NOT NULL CHECK (intent_type IN ('BORROW_AND_LOCK_PT', 'BORROW_AND_TELEPORT_MUSD', 'REPAY_AND_CLOSE', 'MICRO_TELEPORT')),
    collateral_btc_wei NUMERIC(38, 0) NOT NULL CHECK (collateral_btc_wei >= 0),
    musd_amount_wei NUMERIC(38, 0) NOT NULL CHECK (musd_amount_wei > 0),
    min_output_wei NUMERIC(38, 0) NOT NULL,
    relayer_fee_musd_wei NUMERIC(38, 0) NOT NULL DEFAULT 0,
    eip712_signature TEXT NOT NULL,
    deadline_timestamp BIGINT NOT NULL,
    source_tx_hash VARCHAR(66),
    mezo_tx_hash VARCHAR(66),
    wormhole_sequence VARCHAR(64),
    dest_tx_hash VARCHAR(66),
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING_SOURCE' CHECK (
        status IN ('PENDING_SOURCE', 'SOURCE_CONFIRMED', 'EXECUTING_MEZO', 'FAST_FILLED', 'COMPLETED', 'RESCUED_ESCROW', 'FAILED')
    ),
    error_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teleport_intents_user ON teleport_intents (LOWER(user_address), created_at DESC);
CREATE INDEX idx_teleport_intents_status ON teleport_intents (status, deadline_timestamp);

-- 4. Gasless Relayer Execution & Idempotency Log (R-006, R-009, R-017)
CREATE TABLE relayer_transactions (
    relay_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    chain_id INTEGER NOT NULL,
    user_address VARCHAR(42) NOT NULL,
    target_contract VARCHAR(42) NOT NULL,
    function_selector VARCHAR(10) NOT NULL,
    relayer_nonce BIGINT NOT NULL,
    tx_hash VARCHAR(66) UNIQUE,
    gas_used BIGINT,
    gas_Cost_btc_wei NUMERIC(38, 0),
    reimbursed_musd_wei NUMERIC(38, 0) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL CHECK (status IN ('QUEUED', 'SUBMITTED', 'CONFIRMED', 'REVERTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ
);

CREATE INDEX idx_relayer_tx_user ON relayer_transactions (LOWER(user_address), created_at DESC);

-- 5. User Portfolio & MEZO Staking Cache (R-010, R-015)
CREATE TABLE user_positions (
    user_address VARCHAR(42) NOT NULL,
    chain_id INTEGER NOT NULL,
    trove_collateral_btc NUMERIC(38, 18) NOT NULL DEFAULT 0,
    trove_debt_musd NUMERIC(38, 18) NOT NULL DEFAULT 0,
    trove_icr_bps INTEGER NOT NULL DEFAULT 0,
    pt_balance NUMERIC(38, 18) NOT NULL DEFAULT 0,
    yt_balance NUMERIC(38, 18) NOT NULL DEFAULT 0,
    claimable_yield_musd NUMERIC(38, 18) NOT NULL DEFAULT 0,
    claimable_yield_mezo NUMERIC(38, 18) NOT NULL DEFAULT 0,
    staked_mezo_balance NUMERIC(38, 18) NOT NULL DEFAULT 0,
    fee_discount_bps INTEGER NOT NULL DEFAULT 0,
    last_synced_block BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_address, chain_id)
);

CREATE INDEX idx_user_positions_chain ON user_positions (chain_id, updated_at DESC);

-- 6. Indexer Block Checkpoint State (R-017)
CREATE TABLE indexer_checkpoints (
    chain_id INTEGER PRIMARY KEY,
    last_indexed_block BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

