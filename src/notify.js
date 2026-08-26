// Notifications via ntfy.sh. Topic comes from the NTFY_TOPIC secret.

export async function notify({ topic, title, message, priority = 'default', tags = [] }) {
  if (!topic) throw new Error('NTFY_TOPIC is not set — notification not sent.');
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body: message,
    headers: {
      Title: encodeRFC2047(title),
      Priority: priority,
      Tags: tags.join(','),
    },
  });
  if (!res.ok) throw new Error(`ntfy.sh responded with ${res.status}`);
}

// HTTP headers are ASCII; non-ASCII characters in the title need RFC 2047 encoding.
function encodeRFC2047(s) {
  return /^[\x20-\x7e]*$/.test(s)
    ? s
    : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function changeMessage({ from, to, reason, config }) {
  const kitchen = config.heaters.kitchenOneStepLower
    ? `\nKitchen: one level lower (${lower(to)}).`
    : '';
  return {
    title: `Heaters: switch to ${to} (was ${from})`,
    message:
      `Why: ${reason}.\n` +
      `Turn the knob on all ${config.heaters.count} heaters before ${config.check.knobDeadline}.` +
      kitchen,
    priority: 'high',
    tags: [toIdx(to) > toIdx(from) ? 'arrow_up' : 'arrow_down', 'radio_button'],
  };
}

const ORDER = ['0', 'I', 'II', 'III'];
const toIdx = (l) => ORDER.indexOf(l);
const lower = (l) => ORDER[Math.max(0, toIdx(l) - 1)];
