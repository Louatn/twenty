// SyncData: the quoting model, created in code through the same metadata services the settings UI uses.
//
// Funnel: person -> opportunity (closing of one sale) -> quotes -> quote lines.
//   article      the catalogue (reference, name, description, unit price, active)
//   quote        an offer made inside an opportunity: what is sold + the negotiation state
//   quoteLine    one line of a quote, optionally taken from an article (free text allowed)
//   opportunity.activeQuote   the quote currently negotiated; opportunity.amount is computed from its lines
//                             (see SyncdataQuoteAmountListener)
// Quotes read company and contact through their opportunity: they are not repeated on the quote.
//
// These are workspace custom objects, so creating them also creates, by Twenty's own side effects, their
// default view, their navigation entry and their note/task/attachment/timeline relations.
// Called by SyncdataWorkspaceProvisioningService.provision(). Every step is idempotent (skips what exists by name).
import { Injectable, Logger } from '@nestjs/common';

import { FieldMetadataType, RelationType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { FieldMetadataService } from 'src/engine/metadata-modules/field-metadata/services/field-metadata.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { type CreateFieldInput } from 'src/engine/metadata-modules/field-metadata/dtos/create-field.input';
import { ObjectMetadataService } from 'src/engine/metadata-modules/object-metadata/object-metadata.service';

type FieldSeed = Omit<CreateFieldInput, 'objectMetadataId' | 'workspaceId'>;

const OBJECTS = [
  {
    nameSingular: 'article',
    namePlural: 'articles',
    labelSingular: 'Article',
    labelPlural: 'Articles',
    description: 'Catalogue of what SyncData sells',
    icon: 'IconPackage',
  },
  {
    nameSingular: 'quote',
    namePlural: 'quotes',
    labelSingular: 'Quote',
    labelPlural: 'Quotes',
    description: 'An offer made inside an opportunity',
    icon: 'IconFileInvoice',
  },
  {
    nameSingular: 'quoteLine',
    namePlural: 'quoteLines',
    labelSingular: 'Quote line',
    labelPlural: 'Quote lines',
    description: 'One line of a quote',
    icon: 'IconListDetails',
  },
];

// PROVISIONAL: the negotiation states are not final. Louis has not fixed the pipeline yet; change the
// list here (and add a new command) once it is decided.
const QUOTE_STATUS_OPTIONS = [
  { label: 'Draft', value: 'DRAFT', position: 0, color: 'gray' as const },
  { label: 'Sent', value: 'SENT', position: 1, color: 'blue' as const },
  {
    label: 'In negotiation',
    value: 'IN_NEGOTIATION',
    position: 2,
    color: 'orange' as const,
  },
  { label: 'Accepted', value: 'ACCEPTED', position: 3, color: 'green' as const },
  { label: 'Refused', value: 'REFUSED', position: 4, color: 'red' as const },
];

const SCALAR_FIELDS_BY_OBJECT: Record<string, FieldSeed[]> = {
  article: [
    {
      type: FieldMetadataType.TEXT,
      name: 'reference',
      label: 'Reference',
      icon: 'IconHash',
      description: 'Catalogue reference, meant to be unique',
    },
    {
      type: FieldMetadataType.TEXT,
      name: 'description',
      label: 'Description',
      icon: 'IconNotes',
    },
    {
      type: FieldMetadataType.CURRENCY,
      name: 'unitPrice',
      label: 'Unit price',
      icon: 'IconCurrencyEuro',
      description: 'Catalogue price, pre-set on new quote lines',
    },
    {
      type: FieldMetadataType.BOOLEAN,
      name: 'active',
      label: 'Active',
      icon: 'IconToggleRight',
      defaultValue: true,
    },
  ],
  quote: [
    {
      type: FieldMetadataType.TEXT,
      name: 'reference',
      label: 'Reference',
      icon: 'IconHash',
    },
    {
      type: FieldMetadataType.SELECT,
      name: 'status',
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: "'DRAFT'",
      options: QUOTE_STATUS_OPTIONS,
    },
    {
      type: FieldMetadataType.DATE_TIME,
      name: 'sentAt',
      label: 'Sent at',
      icon: 'IconSend',
    },
    {
      type: FieldMetadataType.DATE_TIME,
      name: 'validUntil',
      label: 'Valid until',
      icon: 'IconCalendarDue',
    },
  ],
  quoteLine: [
    {
      type: FieldMetadataType.TEXT,
      name: 'description',
      label: 'Description',
      icon: 'IconNotes',
      description: 'Free text: allowed even when the line has no article',
    },
    {
      type: FieldMetadataType.NUMBER,
      name: 'quantity',
      label: 'Quantity',
      icon: 'IconStack2',
    },
    {
      type: FieldMetadataType.CURRENCY,
      name: 'unitPrice',
      label: 'Unit price',
      icon: 'IconCurrencyEuro',
      description:
        'Copied from the article when the line is created; not a live link to the catalogue price',
    },
    {
      type: FieldMetadataType.NUMBER,
      name: 'discount',
      label: 'Discount (%)',
      icon: 'IconPercentage',
      description: 'Percent, 0 to 100',
    },
  ],
};

// A relation is declared on its many side; Twenty creates the inverse on the other object.
type RelationSeed = {
  objectName: string;
  fieldName: string;
  label: string;
  icon: string;
  targetObjectName: string;
  inverseLabel: string;
  inverseIcon: string;
};

const RELATIONS: RelationSeed[] = [
  {
    objectName: 'quote',
    fieldName: 'opportunity',
    label: 'Opportunity',
    icon: 'IconTargetArrow',
    targetObjectName: 'opportunity',
    inverseLabel: 'Quotes', // opportunity.quotes
    inverseIcon: 'IconFileInvoice',
  },
  {
    objectName: 'quoteLine',
    fieldName: 'quote',
    label: 'Quote',
    icon: 'IconFileInvoice',
    targetObjectName: 'quote',
    inverseLabel: 'Lines', // quote.lines
    inverseIcon: 'IconListDetails',
  },
  {
    objectName: 'quoteLine',
    fieldName: 'article',
    label: 'Article',
    icon: 'IconPackage',
    targetObjectName: 'article',
    inverseLabel: 'Quote lines', // article.quoteLines
    inverseIcon: 'IconListDetails',
  },
  {
    // The quote currently negotiated. Optional. Standard stage and amount are untouched.
    objectName: 'opportunity',
    fieldName: 'activeQuote',
    label: 'Active quote',
    icon: 'IconFileCheck',
    targetObjectName: 'quote',
    inverseLabel: 'Active in opportunities', // quote.activeInOpportunities
    inverseIcon: 'IconTargetArrow',
  },
];

@Injectable()
export class SyncdataQuoteModelProvisioningService {
  private readonly logger = new Logger(
    SyncdataQuoteModelProvisioningService.name,
  );

  constructor(
    private readonly objectMetadataService: ObjectMetadataService,
    private readonly fieldMetadataService: FieldMetadataService,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
  ) {}

  async provision(workspaceId: string): Promise<void> {
    for (const object of OBJECTS) {
      const existing = await this.findObject(workspaceId, object.nameSingular);

      if (!isDefined(existing)) {
        await this.objectMetadataService.createOneObject({
          createObjectInput: object,
          workspaceId,
        });
        this.logger.log(`Created object ${object.nameSingular} on ${workspaceId}`);
      }
    }

    for (const [objectName, seeds] of Object.entries(SCALAR_FIELDS_BY_OBJECT)) {
      const { objectId, fieldNames } = await this.describeObject(
        workspaceId,
        objectName,
      );
      const missing = seeds.filter((seed) => !fieldNames.has(seed.name));

      if (missing.length > 0) {
        await this.fieldMetadataService.createManyFields({
          createFieldInputs: missing.map((seed) => ({
            ...seed,
            objectMetadataId: objectId,
          })),
          workspaceId,
        });
        this.logger.log(
          `Created fields ${missing.map((m) => m.name).join(', ')} on ${objectName} (${workspaceId})`,
        );
      }
    }

    for (const relation of RELATIONS) {
      const source = await this.describeObject(workspaceId, relation.objectName);

      if (source.fieldNames.has(relation.fieldName)) {
        continue;
      }

      const target = await this.findObject(workspaceId, relation.targetObjectName);

      if (!isDefined(target)) {
        throw new Error(
          `Relation target ${relation.targetObjectName} not found in workspace ${workspaceId}`,
        );
      }

      await this.fieldMetadataService.createOneField({
        workspaceId,
        createFieldInput: {
          type: FieldMetadataType.RELATION,
          name: relation.fieldName,
          label: relation.label,
          icon: relation.icon,
          objectMetadataId: source.objectId,
          relationCreationPayload: {
            type: RelationType.MANY_TO_ONE,
            targetObjectMetadataId: target.id,
            targetFieldLabel: relation.inverseLabel,
            targetFieldIcon: relation.inverseIcon,
          },
        },
      });
      this.logger.log(
        `Created relation ${relation.objectName}.${relation.fieldName} on ${workspaceId}`,
      );
    }
  }

  // Always reads fresh maps: the previous steps changed them.
  private async loadMaps(workspaceId: string) {
    await this.flatEntityMapsCacheService.invalidateFlatEntityMaps({
      workspaceId,
      flatMapsKeys: ['flatObjectMetadataMaps', 'flatFieldMetadataMaps'],
    });

    return this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
      {
        workspaceId,
        flatMapsKeys: ['flatObjectMetadataMaps', 'flatFieldMetadataMaps'],
      },
    );
  }

  private async findObject(workspaceId: string, nameSingular: string) {
    const { flatObjectMetadataMaps } = await this.loadMaps(workspaceId);

    return Object.values(flatObjectMetadataMaps.byUniversalIdentifier).find(
      (object) => isDefined(object) && object.nameSingular === nameSingular,
    );
  }

  private async describeObject(workspaceId: string, nameSingular: string) {
    const { flatObjectMetadataMaps, flatFieldMetadataMaps } =
      await this.loadMaps(workspaceId);

    const object = Object.values(flatObjectMetadataMaps.byUniversalIdentifier).find(
      (candidate) =>
        isDefined(candidate) && candidate.nameSingular === nameSingular,
    );

    if (!isDefined(object)) {
      throw new Error(`Object ${nameSingular} not found in workspace ${workspaceId}`);
    }

    const fieldNames = new Set(
      Object.values(flatFieldMetadataMaps.byUniversalIdentifier)
        .filter(
          (field) => isDefined(field) && field.objectMetadataId === object.id,
        )
        .map((field) => field!.name),
    );

    return { objectId: object.id, fieldNames };
  }
}
