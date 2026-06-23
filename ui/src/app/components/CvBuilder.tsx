import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  BriefcaseBusiness,
  ClipboardCopy,
  FileText,
  MapPin,
  Plus,
  Printer,
  Save,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { API, type AppRow, type ApplicationsResponse, type CareerProfile, type JobRow, type JobsResponse } from "../lib/api";
import { COMPOSED, staggerItem } from "../lib/motion";

const today = () => new Date().toISOString().slice(0, 10);

function splitSkills(raw: string): string[] {
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function emptyJob(): JobRow {
  return { title: "", company: "", source: "manual", location: "", score: 0, posted: "", tailored: false, url: "", notes: "" };
}

function emptyApplication(): AppRow {
  return { company: "", role: "", status: "draft", date: today(), url: "", notes: "" };
}

function cvMarkdown(profile: CareerProfile, skills: string[], jobs: JobRow[], apps: AppRow[]): string {
  const lines = [
    `# ${profile.name || "Operator"}`,
    "",
    profile.headline || "",
    profile.location ? `Location: ${profile.location}` : "",
    profile.languages ? `Languages: ${profile.languages}` : "",
    "",
    "## Summary",
    profile.summary || "",
    "",
    "## Skills",
    skills.length ? skills.map((skill) => `- ${skill}`).join("\n") : "-",
    "",
    "## Opportunity Focus",
    ...jobs.slice(0, 8).map((job) => `- ${job.title || "Untitled role"} / ${job.company || "Unspecified"} (${job.score || 0})`),
    "",
    "## Applications",
    ...apps.slice(0, 12).map((app) => `- ${app.role || "Role"} / ${app.company || "Company"} - ${app.status || "draft"} - ${app.date || ""}`),
  ].filter((line) => line !== undefined);
  return lines.join("\n");
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  area,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  area?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-1">
      <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>{label}</span>
      {area ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-h-[118px] w-full min-w-0 resize-none rounded-lg px-3 py-2 outline-none"
          style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full min-w-0 rounded-lg px-3 py-2 outline-none"
          style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
        />
      )}
    </label>
  );
}

export function CvBuilder() {
  const [profile, setProfile] = useState<CareerProfile>({ name: "Operator", skills: [] });
  const [skillsText, setSkillsText] = useState("");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [selectedJob, setSelectedJob] = useState(0);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [career, jobData, appData] = await Promise.all([
      API.career().catch(() => ({ name: "Operator", skills: [] } as CareerProfile)),
      API.jobs().catch(() => ({ jobs: [] } as JobsResponse)),
      API.applications().catch(() => ({ applications: [] } as ApplicationsResponse)),
    ]);
    setProfile(career || { name: "Operator", skills: [] });
    setSkillsText((career?.skills || []).join(", "));
    setJobs(jobData?.jobs || []);
    setApps(appData?.applications || []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const skills = useMemo(() => splitSkills(skillsText), [skillsText]);
  const focusJob = jobs[selectedJob] || null;
  const markdown = useMemo(() => cvMarkdown({ ...profile, skills }, skills, jobs, apps), [apps, jobs, profile, skills]);

  const saveAll = useCallback(async () => {
    setSaving(true);
    setMessage("");
    try {
      const nextProfile = { ...profile, skills };
      await API.saveCareer(nextProfile);
      await API.saveJobs({ jobs });
      await API.saveApplications({ applications: apps });
      setMessage("CV workspace saved.");
      await load();
    } catch (error) {
      setMessage(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [apps, jobs, load, profile, skills]);

  const updateProfile = useCallback((patch: Partial<CareerProfile>) => {
    setProfile((current) => ({ ...current, ...patch }));
  }, []);

  const updateJob = useCallback((index: number, patch: Partial<JobRow>) => {
    setJobs((current) => current.map((job, idx) => (idx === index ? { ...job, ...patch } : job)));
  }, []);

  const addJob = useCallback(() => {
    setJobs((current) => [...current, emptyJob()]);
    setSelectedJob(jobs.length);
  }, [jobs.length]);

  const removeJob = useCallback((index: number) => {
    setJobs((current) => current.filter((_, idx) => idx !== index));
    setSelectedJob(0);
  }, []);

  const addApplication = useCallback((job?: JobRow) => {
    const next = emptyApplication();
    if (job) {
      next.company = job.company;
      next.role = job.title;
      next.url = job.url || "";
      next.notes = job.notes || "";
    }
    setApps((current) => [next, ...current]);
  }, []);

  const updateApplication = useCallback((index: number, patch: Partial<AppRow>) => {
    setApps((current) => current.map((app, idx) => (idx === index ? { ...app, ...patch } : app)));
  }, []);

  const removeApplication = useCallback((index: number) => {
    setApps((current) => current.filter((_, idx) => idx !== index));
  }, []);

  const copyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage("Markdown copied.");
    } catch {
      setMessage("Clipboard unavailable.");
    }
  }, [markdown]);

  return (
    <div className="h-full overflow-auto p-4 md:p-6 xl:p-8">
      <div className="mx-auto max-w-[1500px] space-y-4">
        <motion.header
          className="flex flex-col gap-3 rounded-lg px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
          style={{ border: "1px solid var(--s-edge-accent)", background: "var(--s-glass-light)" }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={COMPOSED}
        >
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2" style={{ color: "var(--s-text-teal)", fontSize: "var(--t-11)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
              <FileText size={15} />
              CV Builder
            </div>
            <h1 className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>
              Profile, opportunities, applications, and resume output
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copyMarkdown} className="inline-flex h-10 items-center gap-2 rounded-lg px-3" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)", background: "rgba(250,248,243,0.035)" }}>
              <ClipboardCopy size={15} />
              Copy Markdown
            </button>
            <button type="button" onClick={() => window.print()} className="inline-flex h-10 items-center gap-2 rounded-lg px-3" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)", background: "rgba(250,248,243,0.035)" }}>
              <Printer size={15} />
              Print
            </button>
            <button type="button" onClick={() => void saveAll()} disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-lg px-3 disabled:opacity-50" style={{ border: "1px solid rgba(20,156,150,0.45)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.10)" }}>
              <Save size={15} />
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </motion.header>

        {message && (
          <div className="rounded-lg px-3 py-2" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)", color: message.includes("failed") ? "var(--s-status-error)" : "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>
            {message}
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.05fr_0.9fr]">
          <section className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}>
            <div className="mb-4 flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
              <Sparkles size={16} style={{ color: "var(--s-text-teal)" }} />
              Profile Source
            </div>
            <div className="grid gap-3">
              <Field label="Name" value={profile.name || ""} onChange={(name) => updateProfile({ name })} placeholder="Your name or operator label" />
              <Field label="Headline" value={profile.headline || ""} onChange={(headline) => updateProfile({ headline })} placeholder="Role focus" />
              <Field label="Summary" value={profile.summary || ""} onChange={(summary) => updateProfile({ summary })} placeholder="Write the profile summary used in the resume." area />
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Location" value={profile.location || ""} onChange={(location) => updateProfile({ location })} />
                <Field label="Languages" value={profile.languages || ""} onChange={(languages) => updateProfile({ languages })} />
              </div>
              <Field label="Skills" value={skillsText} onChange={setSkillsText} placeholder="TypeScript, React, Python" />
            </div>
          </section>

          <section className="cv-print-area rounded-lg p-5" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.04)" }}>
            <div className="flex flex-col gap-1 border-b pb-4" style={{ borderColor: "var(--s-edge-subtle)" }}>
              <h2 style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>{profile.name || "Operator"}</h2>
              <div style={{ color: "var(--s-text-teal-soft)", fontSize: "var(--t-14)", fontWeight: 650 }}>{profile.headline || "Headline not set"}</div>
              <div className="flex flex-wrap items-center gap-3" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>
                <span className="inline-flex items-center gap-2"><MapPin size={13} />{profile.location || "Location not set"}</span>
                {profile.languages && <span>{profile.languages}</span>}
              </div>
            </div>
            <p className="mt-4 min-h-[96px]" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", lineHeight: 1.7 }}>
              {profile.summary || "Summary not written yet."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {skills.length ? skills.map((skill) => (
                <span key={skill} className="rounded-full px-2.5 py-1" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>{skill}</span>
              )) : <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>No skills added.</span>}
            </div>
            <div className="mt-6 grid gap-2">
              <div style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>Target Roles</div>
              {jobs.slice(0, 5).map((job) => (
                <div key={`${job.company}-${job.title}`} className="grid grid-cols-[1fr_auto] gap-3 rounded-lg px-3 py-2" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(5,8,12,0.30)" }}>
                  <span className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}>{job.title || "Untitled role"} / {job.company || "Company not set"}</span>
                  <span style={{ color: Number(job.score) >= 80 ? "var(--s-status-ok)" : "var(--s-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--t-11)" }}>{job.score || 0}</span>
                </div>
              ))}
              {!jobs.length && <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>No opportunities added yet.</div>}
            </div>
          </section>

          <section className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
                <BriefcaseBusiness size={16} style={{ color: "var(--s-text-teal)" }} />
                Opportunity Desk
              </div>
              <button type="button" onClick={addJob} className="inline-flex h-8 items-center gap-2 rounded-lg px-2" style={{ border: "1px solid rgba(20,156,150,0.35)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.08)", fontSize: "var(--t-11)" }}>
                <Plus size={14} />
                Add
              </button>
            </div>
            <div className="max-h-[260px] space-y-2 overflow-auto pr-1">
              {jobs.map((job, index) => (
                <motion.button
                  key={`${job.title}-${job.company}-${index}`}
                  type="button"
                  onClick={() => setSelectedJob(index)}
                  className="grid w-full grid-cols-[1fr_auto] gap-3 rounded-lg px-3 py-2 text-left"
                  style={{ border: selectedJob === index ? "1px solid var(--s-edge-accent)" : "1px solid var(--s-edge-subtle)", background: selectedJob === index ? "rgba(20,156,150,0.08)" : "rgba(250,248,243,0.025)" }}
                  {...staggerItem(index)}
                >
                  <span className="min-w-0">
                    <span className="block truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)", fontWeight: 700 }}>{job.title || "Untitled role"}</span>
                    <span className="block truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>{job.company || "Company"} / {job.location || "Location"}</span>
                  </span>
                  <span style={{ color: "var(--s-text-teal-soft)", fontFamily: "var(--font-mono)", fontSize: "var(--t-11)" }}>{job.score || 0}</span>
                </motion.button>
              ))}
              {!jobs.length && <div className="rounded-lg px-3 py-6 text-center" style={{ border: "1px dashed var(--s-edge-subtle)", color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>Add an opportunity to start matching.</div>}
            </div>

            {focusJob && (
              <div className="mt-4 grid gap-2">
                <Field label="Role" value={focusJob.title || ""} onChange={(title) => updateJob(selectedJob, { title })} />
                <div className="grid gap-2 md:grid-cols-2">
                  <Field label="Company" value={focusJob.company || ""} onChange={(company) => updateJob(selectedJob, { company })} />
                  <Field label="Location" value={focusJob.location || ""} onChange={(location) => updateJob(selectedJob, { location })} />
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <Field label="Score" value={String(focusJob.score || 0)} onChange={(score) => updateJob(selectedJob, { score: Number(score) || 0 })} />
                  <Field label="Source" value={focusJob.source || ""} onChange={(source) => updateJob(selectedJob, { source })} />
                </div>
                <Field label="URL" value={focusJob.url || ""} onChange={(url) => updateJob(selectedJob, { url })} />
                <Field label="Notes" value={focusJob.notes || ""} onChange={(notes) => updateJob(selectedJob, { notes })} area />
                <div className="flex gap-2">
                  <button type="button" onClick={() => addApplication(focusJob)} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg" style={{ border: "1px solid rgba(20,156,150,0.35)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.08)" }}>
                    <Send size={14} />
                    Track Application
                  </button>
                  <button type="button" onClick={() => removeJob(selectedJob)} className="grid h-9 w-10 place-items-center rounded-lg" style={{ border: "1px solid rgba(248,81,73,0.28)", color: "var(--s-status-error)", background: "rgba(248,81,73,0.06)" }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="rounded-lg" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}>
          <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--s-edge-subtle)" }}>
            <div className="flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
              <Send size={16} style={{ color: "var(--s-text-teal)" }} />
              Applications
            </div>
            <button type="button" onClick={() => addApplication()} className="inline-flex h-8 items-center gap-2 rounded-lg px-2" style={{ border: "1px solid rgba(20,156,150,0.35)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.08)", fontSize: "var(--t-11)" }}>
              <Plus size={14} />
              Add
            </button>
          </div>
          <div className="grid gap-2 p-3 lg:grid-cols-2">
            {apps.map((app, index) => (
              <motion.div key={`${app.company}-${app.role}-${index}`} className="grid gap-2 rounded-lg p-3" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }} {...staggerItem(index)}>
                <div className="grid gap-2 md:grid-cols-2">
                  <Field label="Role" value={app.role || ""} onChange={(role) => updateApplication(index, { role })} />
                  <Field label="Company" value={app.company || ""} onChange={(company) => updateApplication(index, { company })} />
                </div>
                <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                  <select value={app.status || "draft"} onChange={(event) => updateApplication(index, { status: event.target.value })} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}>
                    {["draft", "applied", "interview", "offer", "rejected", "closed"].map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                  <input type="date" value={app.date || today()} onChange={(event) => updateApplication(index, { date: event.target.value })} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
                </div>
                <Field label="Notes" value={app.notes || ""} onChange={(notes) => updateApplication(index, { notes })} area />
                <button type="button" onClick={() => removeApplication(index)} className="inline-flex h-8 w-fit items-center gap-2 rounded-lg px-2" style={{ border: "1px solid rgba(248,81,73,0.28)", color: "var(--s-status-error)", background: "rgba(248,81,73,0.06)", fontSize: "var(--t-11)" }}>
                  <Trash2 size={14} />
                  Remove
                </button>
              </motion.div>
            ))}
            {!apps.length && <div className="rounded-lg px-3 py-6 text-center" style={{ border: "1px dashed var(--s-edge-subtle)", color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>No applications tracked yet.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

export default CvBuilder;
