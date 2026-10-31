/* Service worker for block notifications.
 *
 * The push that wakes this worker carries no payload — see push.js for why —
 * so the details come from the dashboard's own API at the moment the phone is
 * woken. That also means the notification shows the CURRENT state: if the node
 * has since confirmed the block, it says so.
 */
'use strict';

self.addEventListener('install', (event) => {
  // Take over immediately. Waiting for every tab to close would mean the first
  // block after enabling notifications is handled by no worker at all.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// A block found in the last ten minutes is what a push is about. Older than
// that and the push must be about something else — there is no payload to ask.
const BLOCK_RECENCY_MS = 600000;

// What to show for this push.
//
// The push itself carries nothing (see push.js), so the reason is worked out
// from live state — and the answer is a LIST, not a choice. Deciding between a
// block and an alarm was the obvious design and it was wrong: a node dying four
// minutes after a block was found produced a push that re-announced the block
// and never mentioned the outage, and because the alarm is only notified once
// per episode, the outage then went unmentioned for six hours. The two are
// independent facts and each gets its own notification, with its own tag, so
// neither can replace the other.
async function describeEvent() {
  const out = [];
  try {
    const res = await fetch('/api/status', { cache: 'no-store', credentials: 'include' });
    if (!res.ok) throw new Error('status ' + res.status);
    const d = await res.json();

    const newest = (d.blocks || [])[0];
    if (newest && Number.isFinite(newest.at) && Date.now() - newest.at < BLOCK_RECENCY_MS) {
      out.push(describeBlock(d));
    }

    const alerts = Array.isArray(d.alerts) ? d.alerts : [];
    if (alerts.length) {
      // Worst first, so the sentence on the lock screen is the one that means
      // nothing is being mined rather than a side note.
      const bad = alerts.filter((a) => a && a.level === 'down');
      const shown = (bad.length ? bad : alerts).map((a) => a && a.text).filter(Boolean);
      out.push({
        title: bad.length ? 'Your pool has stopped mining' : 'Your pool is only half mining',
        body: shown.join(' ') || 'Open the dashboard for the details.',
        tag: 'doge-health',
        sticky: true,
      });
    }

    if (!out.length) {
      // Nothing wrong and no fresh block. This is a recovery — or the test
      // button, which sends the same payloadless push and cannot be told apart
      // from one. The wording is chosen to be true of both.
      out.push({
        title: 'Mining is running',
        body: 'The nodes are answering and work is being handed out.',
        tag: 'doge-health',
        sticky: false,
      });
    }
    return out;
  } catch (e) {
    // The push still has to produce a notification: a push event that resolves
    // without showing one makes the browser show its own "this site was updated
    // in the background" message, which is worse than a plain sentence. It
    // keeps the BLOCK tag, because a push that could not be explained is far
    // more likely to be the block than anything else — and losing a block
    // notification to a transient fetch failure is the expensive mistake here.
    return [{
      title: 'Solo mining',
      body: 'Something happened worth opening the dashboard for.',
      tag: 'doge-block',
      sticky: true,
    }];
  }
}

function describeBlock(d) {
  try {
    // The NEWEST block, which is what the push is about. Preferring the newest
    // *accepted* one would describe an older block on the "found" push, when
    // the new one is still being submitted — so a second block would arrive
    // announcing the first one's height, worker and reward.
    const b = (d.blocks || [])[0];
    if (!b) {
      return {
        title: 'Solo mining',
        body: 'Something happened worth opening the dashboard for.',
        tag: 'doge-block',
        sticky: true,
      };
    }
    // The chain the record belongs to decides both the name and the unit. This
    // is the notification that arrives on a phone with the dashboard closed —
    // the whole point of the push — and calling a 12.5 LTC block "13 DOGE"
    // sends the user to the wrong wallet on the one day it matters.
    // Pepecoin and Soqucoin are named for themselves too; a record without a
    // chain is Dogecoin's, as it always was.
    const NAMES = { LTC: 'Litecoin', DOGE: 'Dogecoin', PEP: 'Pepecoin', SOQ: 'Soqucoin' };
    const chain = NAMES[b.chain] ? b.chain : 'DOGE';
    // Litecoin rewards are small enough that rounding to whole coins loses
    // real money from the message; Dogecoin rewards are five figures and
    // decimals are noise.
    const digits = chain === 'LTC' ? 4 : 0;
    const reward = Number.isFinite(b.reward)
      ? (b.reward / 1e8).toLocaleString('en-US', { maximumFractionDigits: digits }) + ' ' + chain
      : 'reward unknown';
    // A record restored from an older file may be missing fields; a
    // notification reading "Height undefined ... found by undefined" is worse
    // than one that simply omits them.
    const height = Number.isFinite(b.height) ? `Height ${b.height}` : 'A block';
    const who = b.worker ? ` · found by ${b.worker}` : '';
    const state = b.status === 'accepted' ? 'accepted by your node'
      : b.status === 'submitting' ? 'being submitted'
      : b.status;
    return {
      title: 'You found a ' + NAMES[chain] + ' block!',
      body: `${height} · ${reward} · ${state}${who}`,
      tag: 'doge-block',
      sticky: true,
    };
  } catch (e) {
    // The push still has to produce a notification: a push event that resolves
    // without showing one makes the browser show its own "this site was updated
    // in the background" message, which is worse than a plain sentence.
    return {
      title: 'You found a block!',
      body: 'Open the dashboard for the details.',
      tag: 'doge-block',
      sticky: true,
    };
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const notifications = await describeEvent();
    for (const n of notifications) {
      await self.registration.showNotification(n.title, {
        body: n.body,
        // Separate tags, deliberately. With one shared tag a node-down alarm
        // would REPLACE the notification about the block that was just found —
        // and the block is the one you cannot get back.
        tag: n.tag || 'doge-block',
        renotify: true,
        // A recovery does not need to sit on the lock screen until it is
        // acknowledged; a block and a dead node do.
        requireInteraction: n.sticky !== false,
        badge: '/icon-192.png',
        icon: '/icon-192.png',
        data: { url: '/' },
      });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) return client.focus();
    }
    const url = (event.notification.data && event.notification.data.url) || '/';
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
