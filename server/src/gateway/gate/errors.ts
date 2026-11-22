import type { Response } from 'express';

export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large';

/** OpenAI-style error body, the shape every OpenAI SDK already parses. */
export function sendGatewayError(
  res: Response,
  status: number,
  type: GatewayErrorType,
  code: string,
  message: string,
): void {
  if (res.headersSent) return;
  res.status(status).json({ error: { message, type, code } });
}

export function sendNotFound(res: Response): void {
  sendGatewayError(res, 404, 'not_found_error', 'not_found', 'Not found');
}
