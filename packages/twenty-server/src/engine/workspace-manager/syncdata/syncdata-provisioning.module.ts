import { Module } from '@nestjs/common';

import { FieldMetadataModule } from 'src/engine/metadata-modules/field-metadata/field-metadata.module';
import { WorkspaceManyOrAllFlatEntityMapsCacheModule } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.module';
import { ObjectMetadataModule } from 'src/engine/metadata-modules/object-metadata/object-metadata.module';
import { ViewSortModule } from 'src/engine/metadata-modules/view-sort/view-sort.module';
import { ViewModule } from 'src/engine/metadata-modules/view/view.module';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';
import { SyncdataQuoteAmountListener } from 'src/engine/workspace-manager/syncdata/syncdata-quote-amount.listener';
import { SyncdataQuoteModelProvisioningService } from 'src/engine/workspace-manager/syncdata/syncdata-quote-model-provisioning.service';
import { SyncdataWorkspaceProvisioningService } from 'src/engine/workspace-manager/syncdata/syncdata-workspace-provisioning.service';

// Workflow services are resolved lazily by the service (ModuleRef): importing the workflow modules here
// would close an import cycle (WorkspaceModule > UpgradeModule > ... > calendar > WorkspaceModule).
@Module({
  imports: [
    ViewModule,
    ViewSortModule,
    WorkspaceCacheModule,
    ObjectMetadataModule,
    FieldMetadataModule,
    WorkspaceManyOrAllFlatEntityMapsCacheModule,
  ],
  providers: [
    SyncdataWorkspaceProvisioningService,
    SyncdataQuoteModelProvisioningService,
    SyncdataQuoteAmountListener,
  ],
  exports: [SyncdataWorkspaceProvisioningService],
})
export class SyncdataProvisioningModule {}
