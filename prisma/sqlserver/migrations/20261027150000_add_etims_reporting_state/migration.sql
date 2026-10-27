CREATE TABLE [EtimsReportingOperation] (
    [id] VARCHAR(100) NOT NULL,
    [fiscalizationRequestId] VARCHAR(100) NOT NULL,
    [zohoInvoiceId] VARCHAR(255) NOT NULL,
    [adapterType] VARCHAR(10) NULL,
    [adapterConfigurationId] VARCHAR(255) NULL,
    [correlationId] VARCHAR(100) NOT NULL,
    [status] VARCHAR(32) NOT NULL,
    [payloadHash] VARCHAR(64) NOT NULL,
    [attemptNumber] INT NOT NULL CONSTRAINT [EtimsReportingOperation_attemptNumber_df] DEFAULT 0,
    [providerReference] VARCHAR(255) NULL,
    [providerMetadataJson] NVARCHAR(MAX) NULL,
    [errorCategory] VARCHAR(100) NULL,
    [errorMessage] VARCHAR(500) NULL,
    [reconciliationRequired] BIT NOT NULL CONSTRAINT [EtimsReportingOperation_reconciliationRequired_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [EtimsReportingOperation_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [EtimsReportingOperation_pkey] PRIMARY KEY ([id]),
    CONSTRAINT [EtimsReportingOperation_status_check]
        CHECK ([status] IN ('not_configured', 'blocked', 'pending', 'in_progress', 'accepted', 'rejected', 'outcome_unknown', 'reconciliation_required')),
    CONSTRAINT [EtimsReportingOperation_adapterType_check]
        CHECK ([adapterType] IS NULL OR [adapterType] IN ('vscu', 'oscu'))
);

CREATE UNIQUE INDEX [EtimsReportingOperation_fiscalizationRequestId_key]
    ON [EtimsReportingOperation]([fiscalizationRequestId]);
CREATE UNIQUE INDEX [EtimsReportingOperation_correlationId_key]
    ON [EtimsReportingOperation]([correlationId]);
CREATE INDEX [EtimsReportingOperation_status_updatedAt_idx]
    ON [EtimsReportingOperation]([status], [updatedAt]);
CREATE INDEX [EtimsReportingOperation_zohoInvoiceId_idx]
    ON [EtimsReportingOperation]([zohoInvoiceId]);

CREATE TABLE [EtimsReportingAttempt] (
    [id] VARCHAR(100) NOT NULL,
    [operationId] VARCHAR(100) NOT NULL,
    [attemptNumber] INT NOT NULL,
    [startedAt] DATETIME2 NOT NULL,
    [completedAt] DATETIME2 NULL,
    [outcome] VARCHAR(32) NULL,
    [providerReference] VARCHAR(255) NULL,
    [errorCategory] VARCHAR(100) NULL,
    [errorMessage] VARCHAR(500) NULL,
    CONSTRAINT [EtimsReportingAttempt_pkey] PRIMARY KEY ([id]),
    CONSTRAINT [EtimsReportingAttempt_outcome_check]
        CHECK ([outcome] IS NULL OR [outcome] IN ('accepted', 'rejected', 'outcome_unknown'))
);

CREATE UNIQUE INDEX [EtimsReportingAttempt_operationId_attemptNumber_key]
    ON [EtimsReportingAttempt]([operationId], [attemptNumber]);
CREATE INDEX [EtimsReportingAttempt_operationId_startedAt_idx]
    ON [EtimsReportingAttempt]([operationId], [startedAt]);
