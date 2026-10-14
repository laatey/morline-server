# Frontend changes (small, all in `src/components/moor/ai-assistant.tsx`)

Nothing else in the frontend changes. Line numbers refer to the `morline-updated.zip` snapshot.

1. **Add** `provider-icon.tsx` (this folder) next to `ai-assistant.tsx` and copy the logos
   into `src/assets/providers/` (see `assets/providers/README.md`).

2. **Imports.** Add
   `import { StepIcon, stepText, type Step } from "./provider-icon";`
   Delete the local `StepIcon` function (lines 209-213) and drop `Eye` and `Lightbulb` from the
   lucide import if nothing else uses them.

3. **Types.** `steps?: string[]` becomes `steps?: Step[]` (line 53), and in `toolCalls`
   (line 72) `{ steps?: string[]; ... }` becomes `{ steps?: Step[]; ... }`. Old stored messages
   are plain strings and still type-check.

4. **`Steps` component (lines 222-245).** `steps: Step[]` in the props, and the list item becomes
   ```tsx
   <li key={i} className="flex items-center gap-2.5">
     <StepIcon step={s} />
     {stepText(s)}
   </li>
   ```

5. **Stream handler (lines 495-500).**
   ```ts
   if (event === "status") {
     const text = String(data["text"] ?? "");
     const icon = data["icon"] ? String(data["icon"]) : null;
     if (text && (steps.length === 0 || stepText(steps[steps.length - 1]!) !== text)) {
       steps = [...steps, icon ? { text, icon } : text];
       setLiveSteps(steps);
     }
   }
   ```
   and declare `let steps: Step[] = [];` (line 475) and the `liveSteps` state as `Step[]`.

6. **Live list while thinking (lines ~777-787).**
   ```tsx
   {liveSteps.slice(0, -1).map((s) => (
     <li key={stepText(s)} className="flex items-center gap-2.5">
       <StepIcon step={s} />
       {stepText(s)}
     </li>
   ))}
   <li className="flex items-center gap-2.5">
     <Spinner />
     <span>{liveSteps.length ? stepText(liveSteps[liveSteps.length - 1]!) : "Thinking"}…</span>
   </li>
   ```

If you would rather show the logo on the live line too, render `<StepIcon step={...} />` instead
of `<Spinner />` for steps that have an icon; the spinner is fine as is.
