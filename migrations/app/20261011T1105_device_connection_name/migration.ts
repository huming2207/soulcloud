#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/23a6324a7bae0bd60c7e9cec3db65e7544f1eb770f6561b32b1899254d7ae74a/contract';
import endContract from '../../snapshots/23a6324a7bae0bd60c7e9cec3db65e7544f1eb770f6561b32b1899254d7ae74a/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b03e722ab1fb0ba0c3082d97f47a9d157f4d2b0ee030a63ca0f5de81d8f99965/contract';
import startContract from '../../snapshots/b03e722ab1fb0ba0c3082d97f47a9d157f4d2b0ee030a63ca0f5de81d8f99965/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'device',
        column: col('connectionName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
