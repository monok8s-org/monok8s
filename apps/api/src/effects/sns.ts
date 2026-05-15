// AWS SNS effects (#194 — Rule 2 / effect_then_interceptor).
//
// AWS SNS uses a callback-based subscription confirmation flow: the
// publisher sends a SubscriptionConfirmation message containing a
// SubscribeURL, and the subscriber GETs that URL to confirm. The
// HTTP fetch is an IO effect — extracted here as a named function
// so the marketplace router's handler stays pure orchestration.

export interface SnsEffects {
  confirmSubscription: (url: string) => Promise<void>;
}

// Production effect: GET the SNS-supplied SubscribeURL. AWS doesn't
// require a body or specific headers; just hit the URL. SNS responds
// with 200 + a verifier token in the body that we don't need to
// parse — the subscription is confirmed at AWS's side as a result of
// the GET reaching them.
export async function confirmSnsSubscription(url: string): Promise<void> {
  await fetch(url);
}
