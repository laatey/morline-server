// Called for every verified Stripe event. Add a case for each event type you care about.
// If this throws, Stripe receives an error and retries the delivery later.
export async function handleStripeEvent(event, app) {
  switch (event.type) {
    case 'checkout.session.completed':
      app.log.info({ sessionId: event.data.object.id }, 'checkout completed');
      break;
    default:
      app.log.debug({ type: event.type }, 'unhandled Stripe event');
  }
}
