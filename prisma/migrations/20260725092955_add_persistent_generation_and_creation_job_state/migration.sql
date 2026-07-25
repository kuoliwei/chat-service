-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "generationAssistantMessageId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "generationError" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "generationStatus" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "generationTempUserId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "generationUpdatedAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "generationUserMessageId" TEXT;

-- CreateTable
CREATE TABLE "ConversationCreationJob" (
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conversationId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("userId", "characterId")
);
