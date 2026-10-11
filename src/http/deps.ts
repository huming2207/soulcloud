import type { Broker } from "../broker/amqp.ts";
import type { BrokerManagement } from "../broker/management.ts";
import type { BlobStore } from "../firmware/storage.ts";
import type { LogRenderer } from "../logs/render.ts";
import type { OtaService } from "../ota/service.ts";
import type { Commands } from "../rpc/commands.ts";

/** Services the HTTP routes depend on. */
export interface ApiDeps {
  broker: Broker;
  management: BrokerManagement;
  commands: Commands;
  ota: OtaService;
  blobs: BlobStore;
  logRenderer: LogRenderer;
}
