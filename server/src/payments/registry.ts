import type { PaymentMethod } from '../models/donations.js';
import { mpesaProvider } from './mpesa.js';
import { paypalProvider } from './paypal.js';
import { paystackProvider } from './paystack.js';
import type { PaymentProvider } from './types.js';

/** Modular adapter registry — add new providers here. */
const providers: PaymentProvider[] = [mpesaProvider, paystackProvider, paypalProvider];

export const providerForMethod = (m: PaymentMethod) => providers.find((p) => p.method === m);
export const providerById = (id: string) => providers.find((p) => p.id === id);
export const allProviders = () => providers;
