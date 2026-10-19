import { getRequestId, runWithRequestContext } from '../lib/requestContext';

export { getRequestId };

export function runWithRequestId<T>(requestId: string, callback: () => T): T {
  return runWithRequestContext({ requestId }, callback);
}

