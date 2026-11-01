import type { Api } from "./client";
import { httpApi } from "./client";
import type { MockControls } from "./mock";

export const isMock = process.env.NEXT_PUBLIC_API_MOCK === "1";

/* eslint-disable @typescript-eslint/no-require-imports */
// require keeps the mock and its seed data out of production bundles.
const mock = isMock ? (require("./mock") as typeof import("./mock")) : null;
/* eslint-enable @typescript-eslint/no-require-imports */

export const api: Api = mock ? mock.mockApi : httpApi;
export const mockControls: MockControls | null = mock ? mock.mockControls : null;

export * from "./errors";
export * from "./types";
export type { OrdersFilter } from "./client";
