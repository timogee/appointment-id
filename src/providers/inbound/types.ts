/**
 * Inbound messages, normalised. The chat engine never learns whether a message
 * arrived from a terminal or from a Meta webhook.
 */
export interface InboundMessage {
  fromPhone: string;
  body: string;
  receivedAt: Date;
}

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export interface InboundAdapter {
  readonly name: string;
  /** Begin delivering messages to the handler. Resolves when the source closes. */
  start(handler: InboundHandler): Promise<void>;
}
