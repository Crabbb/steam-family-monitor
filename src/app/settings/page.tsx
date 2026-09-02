// FILE: src/app/settings/page.tsx
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Global Settings UI
//   SCOPE: Read/update Steam, Telegram, library polling, watchlist, free-promotion, and achievement monitoring settings
//   DEPENDS: M-API
//   LINKS: M-UI
// END_MODULE_CONTRACT

"use client";

import { useEffect, useState } from "react";
import { Eye, Gift, KeyRound, Library, Loader2, Save, Trophy } from "lucide-react";

interface SettingsFormData {
    steamApiKey: string;
    telegramToken: string;
    telegramChatId: string;
    checkInterval: number;
    libraryPollingEnabled: boolean;
    watchlistEnabled: boolean;
    watchlistIntervalHours: number;
    watchlistMinDiscountPct: number;
    freePromosEnabled: boolean;
    freePromosIntervalHours: number;
    freePromosStartHour: number;
    freePromosEndHour: number;
    freePromosTimezone: string;
    freePromosRegionRu: boolean;
    freePromosRegionKz: boolean;
    freePromosSkipOwnedByAll: boolean;
    freePromosSearchCount: number;
    achievementMonitoringEnabled: boolean;
    achievementIntervalHours: number;
    achievementStartHour: number;
    achievementEndHour: number;
    achievementTimezone: string;
    achievementScanLimit: number;
    achievementFullScanIntervalHours: number;
    achievementSteamHuntersEnabled: boolean;
    achievementTestUserId: number | null;
}

interface UserOption {
    id: number;
    name: string;
}

const DEFAULT_SETTINGS: SettingsFormData = {
    steamApiKey: "",
    telegramToken: "",
    telegramChatId: "",
    checkInterval: 15,
    libraryPollingEnabled: true,
    watchlistEnabled: true,
    watchlistIntervalHours: 12,
    watchlistMinDiscountPct: 1,
    freePromosEnabled: true,
    freePromosIntervalHours: 1,
    freePromosStartHour: 9,
    freePromosEndHour: 23,
    freePromosTimezone: "Europe/Samara",
    freePromosRegionRu: true,
    freePromosRegionKz: true,
    freePromosSkipOwnedByAll: true,
    freePromosSearchCount: 100,
    achievementMonitoringEnabled: true,
    achievementIntervalHours: 6,
    achievementStartHour: 9,
    achievementEndHour: 23,
    achievementTimezone: "Europe/Samara",
    achievementScanLimit: 1000,
    achievementFullScanIntervalHours: 24,
    achievementSteamHuntersEnabled: true,
    achievementTestUserId: null,
};

export default function SettingsPage() {
    const [formData, setFormData] = useState<SettingsFormData>(DEFAULT_SETTINGS);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [users, setUsers] = useState<UserOption[]>([]);
    const [testingAchievements, setTestingAchievements] = useState(false);
    const [message, setMessage] = useState("");

    useEffect(() => {
        let cancelled = false;

        Promise.all([
            fetch("/api/settings").then(res => res.json()),
            fetch("/api/users").then(res => res.json()).catch(() => []),
        ])
            .then(([data, usersData]) => {
                if (cancelled) return;
                setFormData({ ...DEFAULT_SETTINGS, ...data });
                setUsers(Array.isArray(usersData) ? usersData.map((user: UserOption) => ({ id: user.id, name: user.name })) : []);
                setLoading(false);
            })
            .catch(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const updateField = <K extends keyof SettingsFormData>(key: K, value: SettingsFormData[K]) => {
        setFormData(prev => ({ ...prev, [key]: value }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage("");

        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formData),
        });

        setSaving(false);
        if (res.ok) {
            setMessage("Settings saved successfully.");
        } else {
            const data = await res.json().catch(() => ({}));
            setMessage(data.error || "Failed to save settings.");
        }
    };

    const handleAchievementTest = async () => {
        if (!formData.achievementTestUserId) {
            setMessage("Select a user for the sunflower test.");
            return;
        }

        setTestingAchievements(true);
        setMessage("");
        const res = await fetch("/api/achievements/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: formData.achievementTestUserId }),
        });
        setTestingAchievements(false);

        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            setMessage(`Latest sunflower test sent for app ${data.appId}.`);
        } else {
            setMessage(data.error || "Failed to send sunflower test.");
        }
    };

    if (loading) {
        return <div className="text-zinc-400 flex items-center gap-2"><Loader2 className="animate-spin" /> Loading settings...</div>;
    }

    return (
        <div className="max-w-3xl space-y-8">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                <p className="text-zinc-400 mt-2">Configure Steam, Telegram, monitoring schedules, and alert rules.</p>
            </div>

            <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-8">
                <SettingsSection icon={<KeyRound size={20} />} title="Connections">
                    <TextField
                        label="Steam Web API Key"
                        value={formData.steamApiKey}
                        onChange={value => updateField("steamApiKey", value)}
                        placeholder="Enter Steam API Key"
                        required
                    />
                    <TextField
                        label="Telegram Bot Token"
                        type="password"
                        value={formData.telegramToken}
                        onChange={value => updateField("telegramToken", value)}
                        placeholder="123456789:ABCDefGHIJKlmNOPQrsTUVwxyZ"
                        required
                    />
                    <TextField
                        label="Telegram Chat ID"
                        value={formData.telegramChatId}
                        onChange={value => updateField("telegramChatId", value)}
                        placeholder="-1001234567890"
                        required
                    />
                </SettingsSection>

                <SettingsSection icon={<Library size={20} />} title="Library Monitoring">
                    <ToggleField
                        label="Enable new game monitoring"
                        checked={formData.libraryPollingEnabled}
                        onChange={value => updateField("libraryPollingEnabled", value)}
                    />
                    <NumberField
                        label="Checking interval, minutes"
                        min={1}
                        value={formData.checkInterval}
                        onChange={value => updateField("checkInterval", value)}
                    />
                </SettingsSection>

                <SettingsSection icon={<Eye size={20} />} title="Watchlist Discounts">
                    <ToggleField
                        label="Enable watchlist checks"
                        checked={formData.watchlistEnabled}
                        onChange={value => updateField("watchlistEnabled", value)}
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <NumberField
                            label="Interval, hours"
                            min={1}
                            max={24}
                            value={formData.watchlistIntervalHours}
                            onChange={value => updateField("watchlistIntervalHours", value)}
                        />
                        <NumberField
                            label="Minimum discount, %"
                            min={1}
                            max={100}
                            value={formData.watchlistMinDiscountPct}
                            onChange={value => updateField("watchlistMinDiscountPct", value)}
                        />
                    </div>
                </SettingsSection>

                <SettingsSection icon={<Gift size={20} />} title="Free-To-Keep Promotions">
                    <ToggleField
                        label="Enable 100% discount monitoring"
                        checked={formData.freePromosEnabled}
                        onChange={value => updateField("freePromosEnabled", value)}
                    />
                    <ToggleField
                        label="Skip games already owned by all monitored users"
                        checked={formData.freePromosSkipOwnedByAll}
                        onChange={value => updateField("freePromosSkipOwnedByAll", value)}
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <ToggleField
                            label="Region RU"
                            checked={formData.freePromosRegionRu}
                            onChange={value => updateField("freePromosRegionRu", value)}
                        />
                        <ToggleField
                            label="Region KZ"
                            checked={formData.freePromosRegionKz}
                            onChange={value => updateField("freePromosRegionKz", value)}
                        />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                        <NumberField
                            label="Interval, hours"
                            min={1}
                            max={24}
                            value={formData.freePromosIntervalHours}
                            onChange={value => updateField("freePromosIntervalHours", value)}
                        />
                        <NumberField
                            label="Start hour"
                            min={0}
                            max={23}
                            value={formData.freePromosStartHour}
                            onChange={value => updateField("freePromosStartHour", value)}
                        />
                        <NumberField
                            label="End hour"
                            min={0}
                            max={23}
                            value={formData.freePromosEndHour}
                            onChange={value => updateField("freePromosEndHour", value)}
                        />
                        <NumberField
                            label="Search rows"
                            min={1}
                            max={100}
                            value={formData.freePromosSearchCount}
                            onChange={value => updateField("freePromosSearchCount", value)}
                        />
                    </div>
                    <TextField
                        label="Timezone"
                        value={formData.freePromosTimezone}
                        onChange={value => updateField("freePromosTimezone", value)}
                        placeholder="Europe/Samara"
                        required
                    />
                </SettingsSection>

                <SettingsSection icon={<Trophy size={20} />} title="Perfect Achievements">
                    <ToggleField
                        label="Enable sunflower monitoring"
                        checked={formData.achievementMonitoringEnabled}
                        onChange={value => updateField("achievementMonitoringEnabled", value)}
                    />
                    <ToggleField
                        label="Use SteamHunters completion stats"
                        checked={formData.achievementSteamHuntersEnabled}
                        onChange={value => updateField("achievementSteamHuntersEnabled", value)}
                    />
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <NumberField
                            label="Interval, hours"
                            min={1}
                            max={24}
                            value={formData.achievementIntervalHours}
                            onChange={value => updateField("achievementIntervalHours", value)}
                        />
                        <NumberField
                            label="Start hour"
                            min={0}
                            max={23}
                            value={formData.achievementStartHour}
                            onChange={value => updateField("achievementStartHour", value)}
                        />
                        <NumberField
                            label="End hour"
                            min={0}
                            max={23}
                            value={formData.achievementEndHour}
                            onChange={value => updateField("achievementEndHour", value)}
                        />
                        <NumberField
                            label="Games per user"
                            min={1}
                            max={1000}
                            value={formData.achievementScanLimit}
                            onChange={value => updateField("achievementScanLimit", value)}
                        />
                        <NumberField
                            label="Full scan, hours"
                            min={1}
                            max={168}
                            value={formData.achievementFullScanIntervalHours}
                            onChange={value => updateField("achievementFullScanIntervalHours", value)}
                        />
                    </div>
                    <TextField
                        label="Timezone"
                        value={formData.achievementTimezone}
                        onChange={value => updateField("achievementTimezone", value)}
                        placeholder="Europe/Samara"
                        required
                    />
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
                        <SelectField
                            label="Sunflower test user"
                            value={formData.achievementTestUserId ? String(formData.achievementTestUserId) : ""}
                            onChange={value => updateField("achievementTestUserId", value ? Number.parseInt(value, 10) : null)}
                            options={users.map(user => ({ value: String(user.id), label: user.name }))}
                        />
                        <button
                            type="button"
                            onClick={handleAchievementTest}
                            disabled={testingAchievements || !formData.achievementTestUserId}
                            className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-700 bg-zinc-950 px-4 text-sm font-medium text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
                        >
                            {testingAchievements ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : <Trophy className="mr-2 h-4 w-4" />}
                            Send Test
                        </button>
                    </div>
                </SettingsSection>

                <div className="pt-4 border-t border-zinc-800 flex items-center justify-between">
                    <p className={`text-sm ${message.includes("success") ? "text-emerald-400" : "text-red-400"}`}>
                        {message}
                    </p>
                    <button
                        type="submit"
                        disabled={saving}
                        className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : <Save className="mr-2 h-4 w-4" />}
                        Save Settings
                    </button>
                </div>
            </form>
        </div>
    );
}

function SettingsSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-4">
            <div className="flex items-center gap-2 text-zinc-100">
                <span className="text-indigo-400">{icon}</span>
                <h3 className="text-lg font-semibold">{title}</h3>
            </div>
            <div className="space-y-4">
                {children}
            </div>
        </section>
    );
}

function TextField({
    label,
    value,
    onChange,
    placeholder,
    type = "text",
    required = false,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: string;
    required?: boolean;
}) {
    return (
        <label className="block">
            <span className="text-sm font-medium text-zinc-300">{label}</span>
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                className="mt-1 block w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                placeholder={placeholder}
                required={required}
            />
        </label>
    );
}

function NumberField({
    label,
    value,
    onChange,
    min,
    max,
}: {
    label: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
}) {
    return (
        <label className="block">
            <span className="text-sm font-medium text-zinc-300">{label}</span>
            <input
                type="number"
                min={min}
                max={max}
                value={value}
                onChange={e => onChange(Number.parseInt(e.target.value, 10) || min || 0)}
                className="mt-1 block w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                required
            />
        </label>
    );
}

function SelectField({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
}) {
    return (
        <label className="block">
            <span className="text-sm font-medium text-zinc-300">{label}</span>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className="mt-1 block h-10 w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
            >
                <option value="">Select user</option>
                {options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </label>
    );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
    return (
        <label className="flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
            <span className="text-sm font-medium text-zinc-300">{label}</span>
            <input
                type="checkbox"
                checked={checked}
                onChange={e => onChange(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-indigo-600 focus:ring-indigo-500"
            />
        </label>
    );
}

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 — Added controls for library, watchlist, and free-to-keep promotion monitoring]
//   LAST_CHANGE_2: [v1.2.0 - Added perfect-achievement monitoring controls and manual sunflower test action]
//   LAST_CHANGE_3: [v1.3.0 - Added configurable full-scan window for optimized sunflower monitoring]
// END_CHANGE_SUMMARY
