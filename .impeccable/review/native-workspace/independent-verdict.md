**Verdict: PASS. Finding r1-1 (stale `openId` re-opening and re-focusing cards on every render) is RESOLVED. Disposition: ship at this narrow scope.**

I read the source only and did not use the browser.

**Evidence in `src/board/page.ts`:**
- **Render, line 137:** `if(openId){const open=…querySelector('[data-id="'+openId+'"]');openId=null;if(open){open.open=true;open.querySelector('summary').focus(…)}}`. `openId` is cleared right after the lookup and before the card is opened or focused. It is cleared whether or not the card is found, so a stale id can't survive a render.
- **Search:** `el('search').oninput=()=>render(true)` (line 160) now finds `openId` null. The first keystroke no longer pulls focus into a card, so the search input keeps focus.
- **Refresh and Load more:** both go through `load()`, which calls `render()`. Neither sets `openId`, so a card the user closed stays closed.
- **Save (line 118):** `openId=task.id;render(true);` run back to back, with no `await` between them. The id is consumed in that same render. The card has `dataset.id=task.id` (line 105), so the lookup matches.
- **Create (line 167):** `await load(true)` runs first, if the list wasn't loaded yet, and only then `openId=row.id;render();`. The render inside `load` therefore can't consume the id early, and the final render does.
- **Other writers:** the scope change, view change and delete paths set `openId=null`, so nothing else leaves a stale id.

**Unresolved objections to this fix:** none. This is non-blocking and not a regression:
- If an active search filter hides the newly created or saved card, the id is dropped and nothing gets focus. That is the correct failure mode here, and it is better than the old behavior.
- I did not run the live focus path. The author is exercising it in the synthetic browser, and I make no claim about that run.

**Scope:** this is a verdict on the one behavior-only correction, not a new whole-surface review. The earlier layout acceptance and the non-blocking polish items are unchanged, and no recapture is needed.
