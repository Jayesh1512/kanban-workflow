import { DomainError } from '../shared/api.js';
import type { ChatService, ControlBus, IngestionStore, TelegramPort } from '../shared/ports.js';

const pending = (): never => { throw new DomainError('not_configured', 'Telegram ingestion and control transport require the M2 adapter'); };

/** M1 seams are deliberately unavailable. Never fabricate dialogs, imports or delivery receipts. */
export function pendingTelegram(): TelegramPort {
  return {
    async status() { return { state: 'unconfigured', code: 'telegram_m2_pending', detail: 'Telegram adapter is not implemented in M1; no live connection or import exists', checkedAt: new Date().toISOString() }; },
    async loginState() { return { state: 'unconfigured', detail: 'Telegram login becomes available with M2' }; },
    async submitLogin() { return pending(); }, async authorizedSelf() { return null; },
    async *discoverDialogs() { pending(); }, async getHistory() { return pending(); },
    subscribe() { return () => {}; }, async configureControlChat() { return pending(); },
    async reconcileControlSetup() { return pending(); }, async sendControlMessage() { return pending(); },
    async start() {}, async stop() {},
  };
}
export function pendingChats(): ChatService {
  return { async list() { return pending(); }, async setInclusion() { return pending(); }, async importStatus() { return pending(); }, async requestImport() { return pending(); }, async mappingCandidates() { return pending(); }, async correctMapping() { return pending(); } };
}
export function pendingIngestion(): IngestionStore {
  return { async bindAccount() { return pending(); }, async upsertDialog() { return pending(); }, async ingest() { return pending(); }, async claimHistory() { return pending(); }, async commitHistoryBatch() { return pending(); }, async getCursor() { return pending(); }, async getLiveCheckpoint() { return pending(); }, async commitReplay() { return pending(); } };
}
export function pendingControl(): ControlBus {
  return { subscribe() { return () => {}; }, async enqueueProposal() { return pending(); } };
}
