#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/b03e722ab1fb0ba0c3082d97f47a9d157f4d2b0ee030a63ca0f5de81d8f99965/contract';
import endContract from '../../snapshots/b03e722ab1fb0ba0c3082d97f47a9d157f4d2b0ee030a63ca0f5de81d8f99965/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'command',
        columns: [
          col('completedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('deviceId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('error', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('method', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('params', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('requestedById', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('result', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('sentAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('queued'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'command_status_check_55435a5d',
            `"status" IN ('queued', 'sent', 'succeeded', 'failed', 'expired')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'device',
        columns: [
          col('bootId', 'int8', { codecRef: { codecId: 'pg/int8number@1' } }),
          col('chip', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('currentFirmwareId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('elfSha256', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('fwVersion', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('hardwareId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('health', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lastConnectedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
          col('lastDisconnectedAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('lastSeenAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('online', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('ownerId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('passwordHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('platform', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resetReason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('active'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('uptimeMs', 'int8', { codecRef: { codecId: 'pg/int8number@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'device_status_check_3eae755e',
            `"status" IN ('active', 'revoked', 'superseded')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'device_heartbeat',
        columns: [
          col('data', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('deviceId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'BIGSERIAL', { notNull: true, codecRef: { codecId: 'pg/int8number@1' } }),
          col('receivedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('uptimeMs', 'int8', { codecRef: { codecId: 'pg/int8number@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'device_log',
        columns: [
          col('bootId', 'int8', { codecRef: { codecId: 'pg/int8number@1' } }),
          col('deviceId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('deviceTimeMs', 'int8', { codecRef: { codecId: 'pg/int8number@1' } }),
          col('firmwareId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'BIGSERIAL', { notNull: true, codecRef: { codecId: 'pg/int8number@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('level', 'int2', { notNull: true, codecRef: { codecId: 'pg/int2@1' } }),
          col('message', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('packetType', 'int2', { codecRef: { codecId: 'pg/int2@1' } }),
          col('raw', 'bytea', { codecRef: { codecId: 'pg/bytea@1' } }),
          col('receivedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('seq', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('tag', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('device_log_kind_check_1363423d', `"kind" IN ('text', 'bin')`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'enrollment_token',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('deviceId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('deviceName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('ownerId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('tokenHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('usedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'firmware',
        columns: [
          col('binKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('binSha256', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('buildTime', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('chip', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('elfKey', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('elfSha256', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('idfVersion', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('ownerId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('platform', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('size', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('version', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'ota_job',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('firmwareId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('ownerId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'ota_task',
        columns: [
          col('commandId', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('completedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-date@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('deviceId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('error', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('jobId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('previousElfSha256', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('progress', 'int2', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int2@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'ota_task_status_check_2bbbd189',
            `"status" IN ('pending', 'sent', 'downloading', 'verifying', 'rebooting', 'succeeded', 'failed', 'cancelled')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'session',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('lastUsedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('tokenHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'user',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('passwordHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('role', 'text', {
            notNull: true,
            default: lit('user'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('user_role_check_5b6d1a59', `"role" IN ('user', 'admin')`),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'enrollment_token',
        constraint: 'enrollment_token_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'firmware',
        constraint: 'firmware_ownerId_binSha256_key',
        columns: ['ownerId', 'binSha256'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'session',
        constraint: 'session_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'user',
        constraint: 'user_email_key',
        columns: ['email'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'command',
        index: 'command_deviceId_createdAt_idx_e2036dd5',
        columns: ['deviceId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'command',
        index: 'command_deviceId_idx_a7d461e8',
        columns: ['deviceId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'command',
        index: 'command_status_expiresAt_idx_c206f415',
        columns: ['status', 'expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device',
        index: 'device_hardwareId_idx_39f91584',
        columns: ['hardwareId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device',
        index: 'device_ownerId_idx_e2d0c1ef',
        columns: ['ownerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device_heartbeat',
        index: 'device_heartbeat_deviceId_idx_a7d461e8',
        columns: ['deviceId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device_heartbeat',
        index: 'device_heartbeat_deviceId_receivedAt_idx_7390f69d',
        columns: ['deviceId', 'receivedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device_heartbeat',
        index: 'device_heartbeat_receivedAt_idx_9e532856',
        columns: ['receivedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device_log',
        index: 'device_log_deviceId_id_idx_fc846f38',
        columns: ['deviceId', 'id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device_log',
        index: 'device_log_deviceId_idx_a7d461e8',
        columns: ['deviceId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'device_log',
        index: 'device_log_receivedAt_idx_9e532856',
        columns: ['receivedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'enrollment_token',
        index: 'enrollment_token_ownerId_idx_e2d0c1ef',
        columns: ['ownerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'firmware',
        index: 'firmware_elfSha256_idx_91587e2e',
        columns: ['elfSha256'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'firmware',
        index: 'firmware_ownerId_idx_e2d0c1ef',
        columns: ['ownerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ota_job',
        index: 'ota_job_firmwareId_idx_74e8e8c7',
        columns: ['firmwareId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ota_job',
        index: 'ota_job_ownerId_idx_e2d0c1ef',
        columns: ['ownerId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ota_task',
        index: 'ota_task_deviceId_idx_a7d461e8',
        columns: ['deviceId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ota_task',
        index: 'ota_task_deviceId_status_idx_bb11af39',
        columns: ['deviceId', 'status'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'ota_task',
        index: 'ota_task_jobId_idx_623c8f77',
        columns: ['jobId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'session',
        index: 'session_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'command',
        foreignKey: {
          name: 'command_deviceId_fkey',
          columns: ['deviceId'],
          references: { schema: 'public', table: 'device', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'device',
        foreignKey: {
          name: 'device_ownerId_fkey',
          columns: ['ownerId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'device_heartbeat',
        foreignKey: {
          name: 'device_heartbeat_deviceId_fkey',
          columns: ['deviceId'],
          references: { schema: 'public', table: 'device', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'device_log',
        foreignKey: {
          name: 'device_log_deviceId_fkey',
          columns: ['deviceId'],
          references: { schema: 'public', table: 'device', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'enrollment_token',
        foreignKey: {
          name: 'enrollment_token_ownerId_fkey',
          columns: ['ownerId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'firmware',
        foreignKey: {
          name: 'firmware_ownerId_fkey',
          columns: ['ownerId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ota_job',
        foreignKey: {
          name: 'ota_job_ownerId_fkey',
          columns: ['ownerId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ota_job',
        foreignKey: {
          name: 'ota_job_firmwareId_fkey',
          columns: ['firmwareId'],
          references: { schema: 'public', table: 'firmware', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ota_task',
        foreignKey: {
          name: 'ota_task_jobId_fkey',
          columns: ['jobId'],
          references: { schema: 'public', table: 'ota_job', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'ota_task',
        foreignKey: {
          name: 'ota_task_deviceId_fkey',
          columns: ['deviceId'],
          references: { schema: 'public', table: 'device', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'session',
        foreignKey: {
          name: 'session_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
