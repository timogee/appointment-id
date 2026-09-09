/**
 * Outbound messaging. Calling code knows only this interface.
 *
 * sendTemplate exists in the interface from day one even though ConsoleNotifier
 * treats it like text, because WhatsApp requires an approved template outside
 * the 24-hour customer service window. If callers were allowed to assume plain
 * text always works, adding WhatsAppCloudNotifier later would mean touching
 * every call site — which is exactly the rewrite this design prevents.
 */
export interface Notifier {
  sendText(toPhone: string, body: string): Promise<void>;
  sendTemplate(toPhone: string, templateName: string, params: ReadonlyArray<string>): Promise<void>;
}
