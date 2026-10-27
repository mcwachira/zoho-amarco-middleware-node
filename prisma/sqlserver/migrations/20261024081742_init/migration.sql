IF OBJECT_ID(N'[FiscalizationRecord]', N'U') IS NULL
BEGIN
    CREATE TABLE [FiscalizationRecord] (
        [id] VARCHAR(100) NOT NULL,
        [zohoInvoiceId] VARCHAR(255) NOT NULL,
        [status] VARCHAR(32) NOT NULL CONSTRAINT [FiscalizationRecord_status_df] DEFAULT 'Pending',
        [receiptNumber] VARCHAR(100),
        [issuedAt] DATETIME2,
        [failureCode] VARCHAR(100),
        [failureMessage] VARCHAR(2000),
        [outcomeUnknownReason] VARCHAR(2000),
        [createdAt] DATETIME2 NOT NULL CONSTRAINT [FiscalizationRecord_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
        [updatedAt] DATETIME2 NOT NULL,
        CONSTRAINT [FiscalizationRecord_pkey] PRIMARY KEY ([id])
    );
END;

IF NOT EXISTS (
    SELECT 1 FROM [sys].[indexes]
    WHERE [name] = N'FiscalizationRecord_zohoInvoiceId_key'
      AND [object_id] = OBJECT_ID(N'[FiscalizationRecord]')
)
    CREATE UNIQUE INDEX [FiscalizationRecord_zohoInvoiceId_key]
        ON [FiscalizationRecord]([zohoInvoiceId]);

IF NOT EXISTS (
    SELECT 1 FROM [sys].[indexes]
    WHERE [name] = N'FiscalizationRecord_status_idx'
      AND [object_id] = OBJECT_ID(N'[FiscalizationRecord]')
)
    CREATE INDEX [FiscalizationRecord_status_idx]
        ON [FiscalizationRecord]([status]);

IF OBJECT_ID(N'[ZohoOAuthAttempt]', N'U') IS NULL
BEGIN
    CREATE TABLE [ZohoOAuthAttempt] (
        [id] VARCHAR(100) NOT NULL,
        [stateHash] VARCHAR(64) NOT NULL,
        [encryptedCodeVerifier] VARCHAR(512) NOT NULL,
        [expiresAt] DATETIME2 NOT NULL,
        [consumedAt] DATETIME2,
        [createdAt] DATETIME2 NOT NULL CONSTRAINT [ZohoOAuthAttempt_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT [ZohoOAuthAttempt_pkey] PRIMARY KEY ([id])
    );
END;

IF NOT EXISTS (
    SELECT 1 FROM [sys].[indexes]
    WHERE [name] = N'ZohoOAuthAttempt_stateHash_key'
      AND [object_id] = OBJECT_ID(N'[ZohoOAuthAttempt]')
)
    CREATE UNIQUE INDEX [ZohoOAuthAttempt_stateHash_key]
        ON [ZohoOAuthAttempt]([stateHash]);

IF NOT EXISTS (
    SELECT 1 FROM [sys].[indexes]
    WHERE [name] = N'ZohoOAuthAttempt_expiresAt_idx'
      AND [object_id] = OBJECT_ID(N'[ZohoOAuthAttempt]')
)
    CREATE INDEX [ZohoOAuthAttempt_expiresAt_idx]
        ON [ZohoOAuthAttempt]([expiresAt]);

IF OBJECT_ID(N'[ZohoToken]', N'U') IS NULL
BEGIN
    CREATE TABLE [ZohoToken] (
        [id] VARCHAR(20) NOT NULL CONSTRAINT [ZohoToken_id_df] DEFAULT 'primary',
        [encryptedAccessToken] VARCHAR(2048) NOT NULL,
        [encryptedRefreshToken] VARCHAR(2048),
        [accessTokenExpiresAt] DATETIME2 NOT NULL,
        [apiDomain] VARCHAR(255) NOT NULL,
        [scopes] VARCHAR(2000) NOT NULL,
        [createdAt] DATETIME2 NOT NULL CONSTRAINT [ZohoToken_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
        [updatedAt] DATETIME2 NOT NULL,
        CONSTRAINT [ZohoToken_pkey] PRIMARY KEY ([id])
    );
END;
