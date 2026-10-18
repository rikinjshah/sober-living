// POST /functions/v1/intake  (public, verify_jwt = false)
// Validates the web intake form, screens it, stores it, and emails the
// operator and the person who applied.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, env, escapeHtml, json, sendEmail } from "../_shared/http.ts";
import { FLAG_LABELS, validateIntake } from "../_shared/intake.ts";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Honeypot: real people never see or fill this field.
  if (typeof input.website === "string" && input.website.trim()) return json({ ok: true });

  const result = validateIntake(input);
  if (!result.ok) return json({ ok: false, errors: result.errors }, 422);
  const r = result.record;

  // One house for now; take the first unless the form names one.
  const houseQuery = db.from("houses").select("id, name, operator_email").limit(1);
  const { data: house, error: houseErr } = typeof input.house_id === "string"
    ? await houseQuery.eq("id", input.house_id).single()
    : await houseQuery.order("created_at").single();
  if (houseErr || !house) return json({ error: "House not found" }, 400);

  // Light duplicate guard: same contact email + applicant within 10 minutes.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: dup } = await db.from("inquiries").select("id")
    .eq("contact_email", r.contact_email).eq("applicant_name", r.applicant_name)
    .gte("created_at", since).limit(1);
  if (dup?.length) return json({ ok: true, id: dup[0].id, duplicate: true });

  const { data: row, error } = await db.from("inquiries")
    .insert({ ...r, house_id: house.id })
    .select("id")
    .single();
  if (error) {
    console.error(error);
    return json({ error: "Could not save your inquiry. Please call us." }, 500);
  }

  const first = r.contact_name.split(" ")[0];
  const flags = r.screening_flags.map((f) => `<li>${escapeHtml(FLAG_LABELS[f] ?? f)}</li>`).join("");
  const operatorTo = house.operator_email ?? Deno.env.get("OPERATOR_EMAIL");
  const appUrl = Deno.env.get("APP_URL") ?? "";

  await Promise.all([
    sendEmail(
      r.contact_email,
      `We received your inquiry for ${house.name}`,
      `<p>Hi ${escapeHtml(first)},</p>
       <p>Thank you for reaching out about ${escapeHtml(house.name)}. We read every inquiry personally and will be in touch within one business day to set up a short call.</p>
       <p>If this is urgent, reply to this email and we'll prioritise it.</p>`,
    ),
    operatorTo
      ? sendEmail(
        operatorTo,
        `New inquiry: ${r.applicant_name} (${r.submitted_by})`,
        `<p><b>${escapeHtml(r.applicant_name)}</b>, submitted by ${escapeHtml(r.contact_name)} (${r.submitted_by}).</p>
         <p>Contact: ${escapeHtml(r.contact_email)} ${escapeHtml(r.contact_phone ?? "")}</p>
         <p>Room: ${r.preferred_room ?? "no preference"}. Move-in: ${r.desired_move_in ?? "not given"}.</p>
         ${flags ? `<p>Flags:</p><ul>${flags}</ul>` : ""}
         ${appUrl ? `<p><a href="${appUrl}/operator.html#${row.id}">Open in the operator console</a></p>` : ""}`,
      )
      : Promise.resolve(),
  ]);

  return json({ ok: true, id: row.id });
});
