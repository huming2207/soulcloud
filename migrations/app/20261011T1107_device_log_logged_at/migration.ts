#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/23a6324a7bae0bd60c7e9cec3db65e7544f1eb770f6561b32b1899254d7ae74a/contract';
import startContract from '../../snapshots/23a6324a7bae0bd60c7e9cec3db65e7544f1eb770f6561b32b1899254d7ae74a/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/fd6b8a237a9a45b551b8d58c13485c46ce2c9020a56c5eebe5c27e28255d8723/contract';
import endContract from '../../snapshots/fd6b8a237a9a45b551b8d58c13485c46ce2c9020a56c5eebe5c27e28255d8723/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'device_log',
        column: col('loggedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
