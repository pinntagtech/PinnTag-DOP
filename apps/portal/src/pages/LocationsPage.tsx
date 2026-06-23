import { useState } from 'react';
import {
  ChevronRight, Plus, Trash2, Pencil, MapPin, X,
} from 'lucide-react';
import {
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  useDeleteLocation,
  useAddArea,
  useUpdateArea,
  useDeleteArea,
  US_STATES,
  type LocationArea,
  type SeedingLocation,
} from '../hooks/use-locations';
import { Button } from '../components/ui/Button';

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  padding: '14px 18px',
  marginBottom: '8px',
};

const inputStyle: React.CSSProperties = {
  height: '32px',
  padding: '0 10px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  fontSize: '13px',
  background: 'var(--surface)',
  color: 'var(--text)',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  paddingRight: '24px',
  cursor: 'pointer',
};

export default function LocationsPage() {
  const { data: locations, isLoading } = useLocations();
  const createLocation = useCreateLocation();
  const updateLocation = useUpdateLocation();
  const deleteLocation = useDeleteLocation();
  const addArea = useAddArea();
  const updateArea = useUpdateArea();
  const deleteArea = useDeleteArea();

  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingCity, setEditingCity] = useState<string | null>(null);
  const [editingArea, setEditingArea] = useState<{
    cityId: string;
    name: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fireToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--text)',
            }}
          >
            Locations
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Managed list of cities + states + areas used by scraper import
          </p>
        </div>
        <Button
          icon={<Plus size={14} />}
          onClick={() => setShowCreate(true)}
        >
          Add city
        </Button>
      </div>

      {isLoading && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Loading…
        </p>
      )}

      {!isLoading && locations && locations.length === 0 && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          No locations yet.
        </p>
      )}

      <div>
        {locations?.map((city) => {
          const isOpen = expanded.has(city._id);
          return (
            <div key={city._id} style={cardStyle}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <button
                  onClick={() => toggleExpand(city._id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    display: 'flex',
                  }}
                >
                  <ChevronRight
                    size={16}
                    style={{
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 150ms',
                    }}
                  />
                </button>
                <MapPin size={14} style={{ color: 'var(--accent)' }} />
                {editingCity === city._id ? (
                  <CityEditor
                    city={city}
                    onSave={async (patch) => {
                      await updateLocation.mutateAsync({
                        id: city._id,
                        ...patch,
                      });
                      setEditingCity(null);
                      fireToast('City updated');
                    }}
                    onCancel={() => setEditingCity(null)}
                  />
                ) : (
                  <>
                    <span
                      style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--text)',
                      }}
                    >
                      {city.city}
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        background: 'var(--surface-elevated)',
                        color: 'var(--text-secondary)',
                        fontWeight: 500,
                      }}
                    >
                      {city.state}
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {city.areas.length} areas
                    </span>
                    {!city.isActive && (
                      <span
                        style={{
                          fontSize: '11px',
                          color: '#D97706',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: '#FEF3C7',
                        }}
                      >
                        Disabled
                      </span>
                    )}
                  </>
                )}
                {editingCity !== city._id && (
                  <div
                    style={{
                      marginLeft: 'auto',
                      display: 'flex',
                      gap: '4px',
                    }}
                  >
                    <button
                      onClick={() => setEditingCity(city._id)}
                      title="Edit"
                      style={iconBtnStyle}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `Delete ${city.city} and all its areas?`,
                          )
                        )
                          return;
                        await deleteLocation.mutateAsync(city._id);
                        fireToast('City deleted');
                      }}
                      title="Delete"
                      style={{ ...iconBtnStyle, color: '#DC2626' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              {isOpen && (
                <div style={{ marginTop: '12px', paddingLeft: '32px' }}>
                  {city.areas.length === 0 && (
                    <p
                      style={{
                        fontSize: '12px',
                        color: 'var(--text-muted)',
                        marginBottom: '8px',
                      }}
                    >
                      No areas yet.
                    </p>
                  )}
                  {city.areas.map((area) => (
                    <div
                      key={area.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 0',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      {editingArea?.cityId === city._id &&
                      editingArea?.name === area.name ? (
                        <AreaEditor
                          area={area}
                          onSave={async (patch) => {
                            await updateArea.mutateAsync({
                              id: city._id,
                              areaName: area.name,
                              patch,
                            });
                            setEditingArea(null);
                            fireToast('Area updated');
                          }}
                          onCancel={() => setEditingArea(null)}
                        />
                      ) : (
                        <>
                          <span style={{ fontSize: '13px' }}>
                            {area.name}
                          </span>
                          {area.subRegion && (
                            <span
                              style={{
                                fontSize: '11px',
                                color: 'var(--text-muted)',
                              }}
                            >
                              · {area.subRegion}
                            </span>
                          )}
                          {area.state && (
                            <span
                              style={{
                                fontSize: '11px',
                                color: 'var(--text-muted)',
                                fontWeight: 500,
                              }}
                            >
                              · {area.state}
                            </span>
                          )}
                          <div
                            style={{
                              marginLeft: 'auto',
                              display: 'flex',
                              gap: '4px',
                            }}
                          >
                            <button
                              onClick={() =>
                                setEditingArea({
                                  cityId: city._id,
                                  name: area.name,
                                })
                              }
                              style={iconBtnStyle}
                              title="Edit area"
                            >
                              <Pencil size={11} />
                            </button>
                            <button
                              onClick={async () => {
                                if (
                                  !window.confirm(`Remove area "${area.name}"?`)
                                )
                                  return;
                                await deleteArea.mutateAsync({
                                  id: city._id,
                                  areaName: area.name,
                                });
                                fireToast('Area removed');
                              }}
                              style={{ ...iconBtnStyle, color: '#DC2626' }}
                              title="Delete area"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}

                  <AddAreaRow
                    onAdd={async (area) => {
                      await addArea.mutateAsync({ id: city._id, area });
                      fireToast(`Area "${area.name}" added`);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showCreate && (
        <CreateCityModal
          onClose={() => setShowCreate(false)}
          onCreate={async (input) => {
            await createLocation.mutateAsync(input);
            setShowCreate(false);
            fireToast(`City "${input.city}" created`);
          }}
        />
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: '#0A0A0A',
            color: '#ffffff',
            padding: '12px 18px',
            borderRadius: '8px',
            fontSize: '13px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
            zIndex: 200,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  padding: '4px 6px',
  background: 'transparent',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
  display: 'flex',
};

function CityEditor({
  city,
  onSave,
  onCancel,
}: {
  city: SeedingLocation;
  onSave: (patch: {
    city?: string;
    state?: string;
    isActive?: boolean;
  }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [cityName, setCityName] = useState(city.city);
  const [state, setState] = useState(city.state);
  const [isActive, setIsActive] = useState(city.isActive);

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <input
        value={cityName}
        onChange={(e) => setCityName(e.target.value)}
        style={{ ...inputStyle, width: '180px' }}
      />
      <select
        value={state}
        onChange={(e) => setState(e.target.value)}
        style={{ ...selectStyle, width: '90px' }}
      >
        {US_STATES.map((s) => (
          <option key={s.code} value={s.code}>
            {s.code}
          </option>
        ))}
      </select>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '12px',
          color: 'var(--text-secondary)',
        }}
      >
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Active
      </label>
      <Button
        size="sm"
        onClick={() => onSave({ city: cityName, state, isActive })}
      >
        Save
      </Button>
      <Button size="sm" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function AreaEditor({
  area,
  onSave,
  onCancel,
}: {
  area: LocationArea;
  onSave: (patch: Partial<LocationArea>) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(area.name);
  const [subRegion, setSubRegion] = useState(area.subRegion ?? '');
  const [state, setState] = useState(area.state ?? '');

  return (
    <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Area name"
        style={{ ...inputStyle, width: '180px' }}
      />
      <input
        value={subRegion}
        onChange={(e) => setSubRegion(e.target.value)}
        placeholder="Sub-region (optional)"
        style={{ ...inputStyle, width: '140px' }}
      />
      <select
        value={state}
        onChange={(e) => setState(e.target.value)}
        style={{ ...selectStyle, width: '110px' }}
      >
        <option value="">No override</option>
        {US_STATES.map((s) => (
          <option key={s.code} value={s.code}>
            {s.code}
          </option>
        ))}
      </select>
      <Button size="sm" onClick={() => onSave({ name, subRegion, state })}>
        Save
      </Button>
      <Button size="sm" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function AddAreaRow({
  onAdd,
}: {
  onAdd: (area: LocationArea) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [subRegion, setSubRegion] = useState('');
  const [state, setState] = useState('');

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          marginTop: '8px',
          padding: '6px 10px',
          background: 'transparent',
          border: '1px dashed var(--border)',
          borderRadius: '6px',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <Plus size={12} /> Add area
      </button>
    );
  }

  return (
    <div
      style={{
        marginTop: '8px',
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Area name"
        style={{ ...inputStyle, width: '180px' }}
      />
      <input
        value={subRegion}
        onChange={(e) => setSubRegion(e.target.value)}
        placeholder="Sub-region (optional)"
        style={{ ...inputStyle, width: '140px' }}
      />
      <select
        value={state}
        onChange={(e) => setState(e.target.value)}
        style={{ ...selectStyle, width: '110px' }}
      >
        <option value="">No override</option>
        {US_STATES.map((s) => (
          <option key={s.code} value={s.code}>
            {s.code}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={!name.trim()}
        onClick={async () => {
          await onAdd({
            name: name.trim(),
            ...(subRegion ? { subRegion } : {}),
            ...(state ? { state } : {}),
          });
          setName('');
          setSubRegion('');
          setState('');
          setOpen(false);
        }}
      >
        Add
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

function CreateCityModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    city: string;
    state: string;
  }) => void | Promise<void>;
}) {
  const [city, setCity] = useState('');
  const [state, setState] = useState('');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          borderRadius: '10px',
          padding: '20px 24px',
          width: '380px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
          }}
        >
          <h3 style={{ fontSize: '15px', fontWeight: 600 }}>Add city</h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              display: 'flex',
            }}
          >
            <X size={14} />
          </button>
        </div>

        <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          City name
        </label>
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="e.g. Austin"
          style={{ ...inputStyle, width: '100%', marginBottom: '12px' }}
        />

        <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          Default state
        </label>
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          style={{ ...selectStyle, width: '100%', marginBottom: '16px' }}
        >
          <option value="">Select a state</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!city.trim() || !state}
            onClick={() => onCreate({ city: city.trim(), state })}
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
