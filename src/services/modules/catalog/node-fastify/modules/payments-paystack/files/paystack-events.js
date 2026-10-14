// Called for every verified Paystack event. Add a case for each event you care about.
// If this throws, Paystack receives an error and retries the delivery later.
export async function handlePaystackEvent(event, app) {
  switch (event.event) {
    case 'charge.success':
      app.log.info({ reference: event.data.reference }, 'payment succeeded');
      break;
    default:
      app.log.debug({ event: event.event }, 'unhandled Paystack event');
  }
}
