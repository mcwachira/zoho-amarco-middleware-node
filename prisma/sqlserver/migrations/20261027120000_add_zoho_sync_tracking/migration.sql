CREATE TABLE [ZohoSyncRun] (
    [id] VARCHAR(100) NOT NULL,
    [organizationId] VARCHAR(255) NOT NULL,
    [status] VARCHAR(20) NOT NULL CONSTRAINT [ZohoSyncRun_status_df] DEFAULT 'Running',
    [startedAt] DATETIME2 NOT NULL CONSTRAINT [ZohoSyncRun_startedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [completedAt] DATETIME2 NULL,
    [discovered] INT NOT NULL CONSTRAINT [ZohoSyncRun_discovered_df] DEFAULT 0,
    [imported] INT NOT NULL CONSTRAINT [ZohoSyncRun_imported_df] DEFAULT 0,
    [duplicatesSkipped] INT NOT NULL CONSTRAINT [ZohoSyncRun_duplicatesSkipped_df] DEFAULT 0,
    [rejected] INT NOT NULL CONSTRAINT [ZohoSyncRun_rejected_df] DEFAULT 0,
    [failed] INT NOT NULL CONSTRAINT [ZohoSyncRun_failed_df] DEFAULT 0,
    [pagesRetrieved] INT NOT NULL CONSTRAINT [ZohoSyncRun_pagesRetrieved_df] DEFAULT 0,
    [paginationComplete] BIT NOT NULL CONSTRAINT [ZohoSyncRun_paginationComplete_df] DEFAULT 0,
    [errorCode] VARCHAR(100) NULL,
    CONSTRAINT [ZohoSyncRun_pkey] PRIMARY KEY ([id])
);

CREATE INDEX [ZohoSyncRun_organizationId_startedAt_idx]
    ON [ZohoSyncRun]([organizationId], [startedAt]);

CREATE TABLE [ZohoSyncLock] (
    [organizationId] VARCHAR(255) NOT NULL,
    [leaseToken] VARCHAR(100) NOT NULL,
    [leaseExpiresAt] DATETIME2 NOT NULL,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ZohoSyncLock_pkey] PRIMARY KEY ([organizationId])
);
