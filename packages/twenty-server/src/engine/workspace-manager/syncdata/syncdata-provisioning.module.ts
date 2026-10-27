import { Module } from '@nestjs/common';

import { ViewSortModule } from 'src/engine/metadata-modules/view-sort/view-sort.module';
import { ViewModule } from 'src/engine/metadata-modules/view/view.module';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';
import { SyncdataWorkspaceProvisioningService } from 'src/engine/workspace-manager/syncdata/syncdata-workspace-provisioning.service';

// Workflow services are resolved lazily by the service (ModuleRef): importing the workflow modules here
// would close an import cycle (WorkspaceModule > UpgradeModule > ... > calendar > WorkspaceModule).
@Module({
  imports: [ViewModule, ViewSortModule, WorkspaceCacheModule],
  providers: [SyncdataWorkspaceProvisioningService],
  exports: [SyncdataWorkspaceProvisioningService],
})
export class SyncdataProvisioningModule {}
