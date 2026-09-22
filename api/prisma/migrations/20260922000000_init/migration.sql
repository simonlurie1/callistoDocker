-- CreateTable
CREATE TABLE `leads` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NULL,
    `phone` VARCHAR(32) NULL,
    `source` VARCHAR(100) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'new',
    `amount` DOUBLE NULL,
    `currency` VARCHAR(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `conversion_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event_id` VARCHAR(128) NOT NULL,
    `lead_id` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `request_body` TEXT NOT NULL,
    `response_status` INTEGER NULL,
    `response_body` TEXT NULL,
    `last_error` TEXT NULL,
    `last_attempt_at` DATETIME(3) NULL,
    `next_retry_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `conversion_events_event_id_key`(`event_id`),
    UNIQUE INDEX `conversion_events_lead_id_key`(`lead_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `conversion_events` ADD CONSTRAINT `conversion_events_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

