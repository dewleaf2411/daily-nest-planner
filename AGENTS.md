<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

# DaySized Working Rules

- This Lovable repository is the official DaySized project.
- Preserve the current UI unless I explicitly request a design change.
- Do not alter colors, typography, spacing, layout, navigation, or components during logic-only tasks.
- Free-text task input must remain the primary and fastest input method.
- Settings must have smart defaults and must remain optional.
- Fixed commitments such as classes, appointments, practices, and events must never be moved by the scheduler.
- Clearly separate when a user works on something today from when it is actually due.
- Flexible tasks may be divided into smaller focus blocks while preserving their total required duration.
- Never schedule anything after the user's available-until time.
- When everything cannot fit, clearly show what did not fit rather than silently moving fixed commitments.
- Private stress, mood, worries, and personal tasks must remain private by default.
- Never expose API keys or secret credentials in frontend/browser code.
- Make the smallest focused change necessary.
- Run relevant checks or tests after every code change.
- Explain all completed work in simple nontechnical language.
