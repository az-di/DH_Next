import { env } from "../../../config.ts";

// Sendblue settings, in their own file because the client and the parser both need them.

export const sendblueConfig = {
  apiKey: env("SENDBLUE_API_KEY"),
  apiSecret: env("SENDBLUE_API_SECRET"),
  fromNumber: env("SENDBLUE_FROM_NUMBER"),
  webhookSecret: env("SENDBLUE_WEBHOOK_SECRET"),
};
