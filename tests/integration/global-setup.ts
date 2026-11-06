// After the whole run: customer WhatsApp back to its Phase 1 default (off), whatever the suites set.
import { setCustomerWhatsapp } from './helpers';

export default function setup() {
  return async () => {
    await setCustomerWhatsapp(false);
  };
}
