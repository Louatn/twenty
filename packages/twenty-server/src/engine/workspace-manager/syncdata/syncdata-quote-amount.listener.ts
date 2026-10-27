// SyncData: keeps opportunity.amount computed from the lines of the opportunity's active quote, on the
// server, from record events.
//
//   amount = sum over the active quote's lines of quantity * unitPrice * (1 - discount / 100)
//
//   quoteLine created / updated / deleted / restored -> every opportunity whose activeQuote is the line's quote
//   opportunity.activeQuote set or changed           -> that opportunity
//
// opportunity.amount is therefore computed (and read-only in the UI, see the 2-43 command).
// No loop: the amount is only written when it differs from what is stored, and the write only produces an
// opportunity update event, which this listener only reacts to when activeQuoteId changed.
import { Injectable, Logger } from '@nestjs/common';

import {
  type ObjectRecordCreateEvent,
  type ObjectRecordDeleteEvent,
  type ObjectRecordUpdateEvent,
} from 'twenty-shared/database-events';
import { type ObjectRecord } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';

type Money = {
  amountMicros: number | string | null;
  currencyCode: string | null;
};

// Currency used when neither the lines nor the opportunity carry one.
const DEFAULT_CURRENCY_CODE = 'EUR';

const toNumber = (value: number | string | null | undefined): number =>
  isDefined(value) ? Number(value) : 0;

@Injectable()
export class SyncdataQuoteAmountListener {
  private readonly logger = new Logger(SyncdataQuoteAmountListener.name);

  constructor(private readonly workspaceOrmManager: WorkspaceOrmManager) {}

  @OnDatabaseBatchEvent('quoteLine', DatabaseEventAction.CREATED)
  async onQuoteLineCreated(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent<ObjectRecord>>,
  ) {
    await this.syncFromQuotes(
      payload.workspaceId,
      payload.events.map((event) => event.properties.after.quoteId),
    );
  }

  @OnDatabaseBatchEvent('quoteLine', DatabaseEventAction.UPDATED)
  async onQuoteLineUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<ObjectRecord>>,
  ) {
    // a line moved to another quote changes both amounts
    await this.syncFromQuotes(
      payload.workspaceId,
      payload.events.flatMap((event) => [
        event.properties.before.quoteId,
        event.properties.after.quoteId,
      ]),
    );
  }

  @OnDatabaseBatchEvent('quoteLine', DatabaseEventAction.DELETED)
  async onQuoteLineDeleted(
    payload: WorkspaceEventBatch<ObjectRecordDeleteEvent<ObjectRecord>>,
  ) {
    await this.syncFromQuotes(
      payload.workspaceId,
      payload.events.map((event) => event.properties.before.quoteId),
    );
  }

  @OnDatabaseBatchEvent('quoteLine', DatabaseEventAction.DESTROYED)
  async onQuoteLineDestroyed(
    payload: WorkspaceEventBatch<ObjectRecordDeleteEvent<ObjectRecord>>,
  ) {
    await this.syncFromQuotes(
      payload.workspaceId,
      payload.events.map((event) => event.properties.before.quoteId),
    );
  }

  @OnDatabaseBatchEvent('quoteLine', DatabaseEventAction.RESTORED)
  async onQuoteLineRestored(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent<ObjectRecord>>,
  ) {
    await this.syncFromQuotes(
      payload.workspaceId,
      payload.events.map((event) => event.properties.after.quoteId),
    );
  }

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.CREATED)
  async onOpportunityCreated(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent<ObjectRecord>>,
  ) {
    await this.syncOpportunities(
      payload.workspaceId,
      payload.events
        .filter((event) => isDefined(event.properties.after.activeQuoteId))
        .map((event) => event.recordId),
    );
  }

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.UPDATED)
  async onOpportunityUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<ObjectRecord>>,
  ) {
    // Only a set or changed activeQuote matters. When it is cleared (null) the amount is deliberately
    // left as it is: the last synced value stays until another active quote is set.
    await this.syncOpportunities(
      payload.workspaceId,
      payload.events
        .filter(
          (event) =>
            isDefined(event.properties.after.activeQuoteId) &&
            event.properties.before.activeQuoteId !==
              event.properties.after.activeQuoteId,
        )
        .map((event) => event.recordId),
    );
  }

  private async syncFromQuotes(
    workspaceId: string,
    quoteIds: (string | null | undefined)[],
  ) {
    const uniqueQuoteIds = [...new Set(quoteIds.filter(isDefined))];

    if (uniqueQuoteIds.length === 0) {
      return;
    }

    await this.inWorkspace(workspaceId, async () => {
      const opportunities = await this.getOpportunityRepository().find({
        where: uniqueQuoteIds.map((quoteId) => ({ activeQuoteId: quoteId })),
      });

      await this.writeAmounts(opportunities);
    });
  }

  private async syncOpportunities(
    workspaceId: string,
    opportunityIds: string[],
  ) {
    if (opportunityIds.length === 0) {
      return;
    }

    await this.inWorkspace(workspaceId, async () => {
      const opportunities = await this.getOpportunityRepository().find({
        where: opportunityIds.map((id) => ({ id })),
      });

      await this.writeAmounts(opportunities);
    });
  }

  // One currency per quote is assumed: the first priced line's currency code is used and a warning is
  // logged when lines differ. A quote without lines gives 0.
  private async writeAmounts(opportunities: ObjectRecord[]) {
    const lineRepository = this.workspaceOrmManager.getRepository('quoteLine', {
      shouldBypassPermissionChecks: true,
    });

    for (const opportunity of opportunities) {
      if (!isDefined(opportunity.activeQuoteId)) {
        continue;
      }

      const lines = await lineRepository.find({
        where: { quoteId: opportunity.activeQuoteId },
      });
      const currencyCodes = new Set<string>();
      let amountMicros = 0;

      for (const line of lines) {
        if (isDefined(line.unitPrice?.currencyCode)) {
          currencyCodes.add(line.unitPrice.currencyCode);
        }
        amountMicros += Math.round(
          toNumber(line.quantity) *
            toNumber(line.unitPrice?.amountMicros) *
            (1 - toNumber(line.discount) / 100),
        );
      }

      if (currencyCodes.size > 1) {
        this.logger.warn(
          `quote ${opportunity.activeQuoteId} mixes currencies (${[...currencyCodes].join(', ')}): using the first`,
        );
      }

      const amount: Money = {
        amountMicros,
        currencyCode:
          [...currencyCodes][0] ??
          opportunity.amount?.currencyCode ??
          DEFAULT_CURRENCY_CODE,
      };

      // skipping an unchanged value is what stops loops
      if (
        toNumber(opportunity.amount?.amountMicros) === amount.amountMicros &&
        opportunity.amount?.currencyCode === amount.currencyCode
      ) {
        continue;
      }

      await this.getOpportunityRepository().update(opportunity.id, { amount });
      this.logger.log(
        `opportunity ${opportunity.id}: amount = ${amount.amountMicros} micros ${amount.currencyCode}`,
      );
    }
  }

  private getOpportunityRepository() {
    return this.workspaceOrmManager.getRepository('opportunity', {
      shouldBypassPermissionChecks: true,
    });
  }

  private inWorkspace(workspaceId: string, work: () => Promise<void>) {
    return this.workspaceOrmManager.executeInWorkspaceContext(
      work,
      buildSystemAuthContext(workspaceId),
    );
  }
}
