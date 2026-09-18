import { Loader, Select } from "@mantine/core";
import type { HarnessId } from "@berdloop/agent";
import type { RolePreference } from "./agent-preferences";
import type { HarnessCatalog } from "./harness-catalog";

export function HarnessModelSelects({
  preference,
  onChange,
  catalog,
  loading,
  connected,
  projectSettings,
  override,
}: {
  preference: Required<RolePreference>;
  projectSettings: boolean;
  override?: RolePreference;
  catalog?: HarnessCatalog;
  loading: boolean;
  connected: boolean;
  onChange: (patch: Partial<RolePreference>) => void;
}) {
  const harness = preference.harness;
  const inheritValue = "__organization__";
  const inherited =
    projectSettings && override?.harness == null && override?.model == null;
  const organizationOption = {
    value: inheritValue,
    label: "Organization settings",
  };
  const inherit = () => onChange({ harness: undefined, model: undefined });
  const current = catalog?.harnesses.find((option) => option.id === harness);
  const models = current?.models ?? [];
  const options = [
    ...(projectSettings ? [organizationOption] : []),
    { value: "", label: "Harness default" },
    ...models,
  ];
  // Keep an existing/custom model visible even if the CLI no longer lists it.
  if (
    preference.model &&
    !options.some(({ value }) => value === preference.model)
  )
    options.push({
      value: preference.model,
      label: `${preference.model} (saved)`,
    });

  return (
    <>
      <Select
        label="Harness"
        searchable
        allowDeselect={false}
        disabled={loading || !catalog}
        placeholder={
          loading ? "Loading harnesses…" : "Harness options unavailable"
        }
        data={[
          ...(projectSettings ? [organizationOption] : []),
          ...(catalog?.harnesses ?? []).map(({ id, name }) => ({
            value: id,
            label: name,
          })),
        ]}
        value={inherited ? inheritValue : harness}
        nothingFoundMessage="No matching harnesses"
        onChange={(value) => {
          if (value === inheritValue) inherit();
          else if (value && (value !== harness || inherited))
            onChange({ harness: value as HarnessId, model: "" });
        }}
      />
      <Select
        mt="md"
        label="Default model"
        searchable
        allowDeselect={false}
        data={options}
        value={inherited ? inheritValue : preference.model}
        disabled={loading || !catalog || !connected}
        rightSection={loading ? <Loader size="xs" /> : undefined}
        description={
          loading
            ? "Loading models…"
            : !connected
              ? "Open the desktop app to load models from your harness."
              : current && !current.error && models.length === 0
                ? "This harness returned no models."
                : undefined
        }
        error={current?.error}
        nothingFoundMessage="No matching models"
        onChange={(value) => {
          if (value === inheritValue) inherit();
          else if (value !== null) onChange({ harness, model: value });
        }}
      />
    </>
  );
}
