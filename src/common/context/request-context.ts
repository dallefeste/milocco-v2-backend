import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextData {
  userId?: number;
  username?: string;
}

/** Dati della richiesta corrente (utente) accessibili ovunque, es. per il registro modifiche. */
export const requestContext = new AsyncLocalStorage<RequestContextData>();
export const currentUser = (): RequestContextData => requestContext.getStore() ?? {};
