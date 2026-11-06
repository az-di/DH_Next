import { env } from "../../../config.ts";

export const sendblueConfig = {
  apiKey: env("SENDBLUE_API_KEY"),
  apiSecret: env("SENDBLUE_API_SECRET"),
  fromNumber: env("SENDBLUE_FROM_NUMBER"),
  webhookSecret: env("SENDBLUE_WEBHOOK_SECRET"),
};
