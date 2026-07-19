import { consumeEpiphanyOperatorDeliveries } from "@voidbot/core";

export interface EpiphanyOperatorDeliveryConsumerConfig {
  applicationId: string;
  requestStorePath: string;
  deliveryStorePath: string;
  checkpointStorePath: string;
  bifrostRoot: string;
  cultlibRoot?: string;
  pollIntervalMs: number;
}

export function startEpiphanyOperatorDeliveryConsumer(config: EpiphanyOperatorDeliveryConsumerConfig): void {
  let running = false;
  const pulse = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await consumeEpiphanyOperatorDeliveries(
        {
          requestStorePath: config.requestStorePath,
          deliveryStorePath: config.deliveryStorePath,
          checkpointStorePath: config.checkpointStorePath,
          bifrostRoot: config.bifrostRoot,
          cultlibRoot: config.cultlibRoot,
        },
        async (applicationId, interactionToken, content) => {
          if (applicationId !== config.applicationId) throw new Error("interaction application binding mismatch");
          const response = await fetch(
            `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content }),
            },
          );
          if (!response.ok) throw new Error(`Discord interaction edit failed with HTTP ${response.status}`);
        },
      );
      if (result.failed > 0) console.error("Epiphany operator delivery pulse retained failures for retry:", result);
    } catch (error) {
      console.error("Epiphany operator delivery pulse failed without acknowledging deliveries:", error);
    } finally { running = false; }
  };
  void pulse();
  const timer = setInterval(() => void pulse(), config.pollIntervalMs);
  timer.unref?.();
}
