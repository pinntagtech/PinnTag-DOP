import { useState } from 'react';
import { ImageOff, ImagePlus, Layers, Send } from 'lucide-react';
import { StatCard } from '../components/ui/StatCard';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import {
  useCoverBackfillStats,
  useQueueCoverBatch,
  type QueueBatchResult,
} from '../hooks/use-cover-backfill';

export default function MissingCoversPage() {
  const { data: stats, isLoading, isError, error } = useCoverBackfillStats();
  const queueBatch = useQueueCoverBatch();

  const [lastResult, setLastResult] = useState<QueueBatchResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const handleQueue = () => {
    setLastError(null);
    queueBatch.mutate(undefined, {
      onSuccess: (result) => setLastResult(result),
      onError: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to queue batch';
        setLastError(message);
      },
    });
  };

  const batchesRemaining =
    stats && stats.batchSize > 0
      ? Math.ceil(stats.totalCoverless / stats.batchSize)
      : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        width: '100%',
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ImageOff size={18} style={{ color: 'var(--text-secondary)' }} />
            <h1
              style={{
                fontSize: '18px',
                fontWeight: 600,
                margin: 0,
                color: 'var(--text)',
              }}
            >
              Missing Covers
            </h1>
          </div>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: 'var(--surface-elevated)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              padding: '4px 10px',
              borderRadius: '999px',
            }}
          >
            {stats?.environment ?? 'staging'}
          </span>
        </div>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            margin: 0,
          }}
        >
          Queues gallery fetches for 500 coverless businesses. The bots scrape
          Google and set each cover from the first real photo. This runs in
          the background — covers appear as each business finishes. Verify a
          batch looks right in the consumer app before queueing the next.
        </p>
      </div>

      {/* Stat cards */}
      {isLoading ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '20px',
          }}
        >
          <Skeleton className="h-[108px]" />
          <Skeleton className="h-[108px]" />
          <Skeleton className="h-[108px]" />
        </div>
      ) : isError ? (
        <div
          style={{
            padding: '16px',
            background: 'var(--red-subtle)',
            color: 'var(--red)',
            borderRadius: 'var(--radius)',
            fontSize: '13px',
          }}
        >
          Failed to load stats:{' '}
          {error instanceof Error ? error.message : 'unknown error'}
        </div>
      ) : (
        stats && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '20px',
            }}
          >
            <StatCard
              label="Coverless total"
              value={stats.totalCoverless.toLocaleString()}
              sub="missing cover, has placeId"
              icon={<ImageOff size={16} />}
            />
            <StatCard
              label="In-flight (queued)"
              value={stats.inFlight.toLocaleString()}
              sub="gallery jobs pending/running"
              subVariant={stats.inFlight > 0 ? 'success' : 'neutral'}
              icon={<Send size={16} />}
              iconColor={
                stats.inFlight > 0 ? 'var(--green)' : 'var(--text-muted)'
              }
            />
            <StatCard
              label="Batch size"
              value={stats.batchSize}
              sub={
                batchesRemaining !== null
                  ? `~${batchesRemaining} batch${batchesRemaining === 1 ? '' : 'es'} to clear queue`
                  : undefined
              }
              icon={<Layers size={16} />}
            />
          </div>
        )
      )}

      {/* Queue action */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Button
            variant="primary"
            onClick={handleQueue}
            loading={queueBatch.isPending}
            disabled={queueBatch.isPending || isLoading || !stats}
            icon={<ImagePlus size={14} />}
          >
            Queue next 500
          </Button>
          {stats && (
            <span
              style={{ fontSize: '12px', color: 'var(--text-muted)' }}
            >
              {stats.totalCoverless.toLocaleString()} coverless ÷{' '}
              {stats.batchSize} per batch ={' '}
              {batchesRemaining ?? '—'} batch
              {batchesRemaining === 1 ? '' : 'es'} remaining
            </span>
          )}
        </div>

        {lastError && (
          <div
            style={{
              padding: '10px 12px',
              background: 'var(--red-subtle)',
              color: 'var(--red)',
              borderRadius: 'var(--radius)',
              fontSize: '13px',
            }}
          >
            {lastError}
          </div>
        )}

        {lastResult && !lastError && (
          <div
            style={{
              padding: '10px 12px',
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Queued <strong style={{ color: 'var(--text)' }}>
              {lastResult.queued}
            </strong>{' '}
            · skipped <strong style={{ color: 'var(--text)' }}>
              {lastResult.skippedInFlight}
            </strong>{' '}
            already in-flight · remaining{' '}
            <strong style={{ color: 'var(--text)' }}>
              {lastResult.remainingCoverless.toLocaleString()}
            </strong>
          </div>
        )}
      </div>
    </div>
  );
}
