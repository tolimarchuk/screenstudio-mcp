// Zod building blocks shared by project settings and editor ops.
import { z } from "zod";

export const num = z.number().finite();
export const unit = num.min(0).max(1);
export const ms = num.min(0);
export const rect01 = z.object({ x: unit, y: unit, width: unit, height: unit }).strict();
