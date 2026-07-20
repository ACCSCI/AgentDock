import { toast as sonner } from "sonner";

/**
 * Stable application toast API backed by Sonner. Keeping this adapter means
 * business code does not depend on the presentation library directly.
 */
export const toast = {
  info: (message: string, duration = 4000) => sonner.info(message, { duration }),
  success: (message: string, duration = 3000) => sonner.success(message, { duration }),
  error: (message: string, duration = 6000) => sonner.error(message, { duration }),
  warn: (message: string, duration = 5000) => sonner.warning(message, { duration }),
};
