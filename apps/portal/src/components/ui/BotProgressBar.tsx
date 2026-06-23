interface StageProgress {
  status: string;
  current?: number;
  total?: number;
  items?: number;
  folders?: number;
  images?: number;
  foldersTotal?: number;
  currentFolder?: string;
  expanding?: number;
}

interface BotScrape {
  status: string;
  startedAt?: string;
  completedAt?: string;
  currentStage?: string;
  currentDetail?: string;
  progress?: {
    gallery?: StageProgress;
    menu?: StageProgress;
    reviews?: StageProgress;
  };
  reviewCount?: number;
  galleryFolders?: number;
  galleryImages?: number;
  menuItems?: number;
  error?: string;
}

type StageStatus =
  | 'not_started'
  | 'in_progress'
  | 'done'
  | 'paused'
  | 'failed'
  | 'skipped';

function getStageStatus(
  stageData: StageProgress | undefined,
  label: string,
  botScrape: BotScrape,
): StageStatus {
  const overallDone = botScrape.status === 'done';
  const overallFailed = botScrape.status === 'failed';
  const overallScraping = botScrape.status === 'scraping';
  const stageStatus = stageData?.status || 'pending';

  // Check if paused (scraping started but went stale)
  const isPaused = (() => {
    if (!botScrape.startedAt) return false;
    const started = new Date(botScrape.startedAt).getTime();
    const now = Date.now();
    const minutesElapsed = (now - started) / 1000 / 60;
    return overallScraping && minutesElapsed > 10
      && stageStatus === 'pending';
  })();

  if (stageStatus === 'scraping') return 'in_progress';

  if (stageStatus === 'done') return 'done';

  if (overallDone) {
    // Overall done but this stage has no data
    const hasData =
      (label === 'Gallery' && (stageData?.images || 0) > 0) ||
      (label === 'Menu' && (stageData?.items || 0) > 0) ||
      (label === 'Reviews' && (stageData?.current || 0) > 0);
    return hasData ? 'done' : 'skipped';
  }

  if (overallFailed) return 'failed';

  if (isPaused) return 'paused';

  return 'not_started';
}

// Derive actual status from progress fields
function getActualStatus(
  botScrape: BotScrape | null | undefined,
): string {
  if (!botScrape) return 'not_started';

  const p = botScrape.progress;
  const overallStatus = botScrape.status;

  // If overall is pending/null — not started regardless
  // of what individual stages say (could be stale)
  if (!overallStatus || overallStatus === 'pending') {
    return 'not_started';
  }

  // Explicit terminal states
  if (overallStatus === 'done') return 'done';
  if (overallStatus === 'failed') return 'failed';

  // Active scraping — check individual stages
  if (overallStatus === 'scraping') {
    const anyInProgress =
      p?.gallery?.status === 'scraping' ||
      p?.menu?.status === 'scraping' ||
      p?.reviews?.status === 'scraping';

    const anyDone =
      p?.gallery?.status === 'done' ||
      p?.menu?.status === 'done' ||
      p?.reviews?.status === 'done';

    if (anyInProgress) return 'scraping';
    if (anyDone) return 'scraping'; // partial = still going
    return 'scraping'; // overall says scraping, trust it
  }

  return 'not_started';
}

const STATUS_CONFIG: Record<StageStatus, {
  label: string;
  color: string;
  barColor: string;
  pct: number | null;
  pulse: boolean;
}> = {
  not_started: {
    label: 'Not started',
    color: '#A1A1AA',
    barColor: '#F4F4F5',
    pct: 0,
    pulse: false,
  },
  in_progress: {
    label: 'In progress',
    color: '#D97706',
    barColor: '#D97706',
    pct: null, // calculated dynamically
    pulse: true,
  },
  done: {
    label: '✓ Done',
    color: '#16A34A',
    barColor: '#16A34A',
    pct: 100,
    pulse: false,
  },
  paused: {
    label: '⏸ Paused',
    color: '#71717A',
    barColor: '#E4E4E7',
    pct: 20,
    pulse: false,
  },
  failed: {
    label: '✗ Failed',
    color: '#DC2626',
    barColor: '#FCA5A5',
    pct: 0,
    pulse: false,
  },
  skipped: {
    label: 'Not fetched',
    color: '#A1A1AA',
    barColor: '#F4F4F5',
    pct: 0,
    pulse: false,
  },
};

// Compact single-line view for table cell
export function BotProgressCompact({
  botScrape,
}: {
  botScrape: BotScrape | null | undefined;
}) {
  if (!botScrape) {
    return (
      <span style={{ fontSize: '12px', color: '#A1A1AA' }}>
        —
      </span>
    );
  }

  const status = getActualStatus(botScrape);

  if (status === 'failed') {
    return (
      <span style={{ fontSize: '12px', color: '#DC2626' }}>
        ✗ Failed
      </span>
    );
  }

  if (status === 'done') {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}>
        <span style={{ fontSize: '12px', color: '#16A34A' }}>
          ✓ Done
        </span>
        <span style={{ fontSize: '11px', color: '#A1A1AA' }}>
          {botScrape.reviewCount ?? 0}rev ·{' '}
          {botScrape.galleryImages ?? 0}img ·{' '}
          {botScrape.menuItems ?? 0}menu
        </span>
      </div>
    );
  }

  if (status === 'scraping') {
    const p = botScrape.progress;
    const activeDetail = (() => {
      // Active stage details
      if (p?.reviews?.status === 'scraping') {
        if ((p.reviews.expanding ?? 0) > 0) {
          return `⭐ Expanding ${p.reviews.expanding} reviews...`;
        }
        if (p.reviews.total && (p.reviews.current ?? 0) > 0) {
          return `⭐ ${p.reviews.current} / ${p.reviews.total}`;
        }
        return '⭐ Loading reviews...';
      }

      if (p?.gallery?.status === 'scraping') {
        if (p.gallery.currentFolder) {
          return `📸 ${p.gallery.currentFolder}`;
        }
        if ((p.gallery.images ?? 0) > 0) {
          return `📸 ${p.gallery.images} images saved`;
        }
        return '📸 Saving gallery...';
      }

      if (p?.menu?.status === 'scraping') {
        return '🍽 Saving menu...';
      }

      // Transition states
      if (
        p?.gallery?.status === 'done' &&
        p?.menu?.status !== 'done'
      ) {
        return '🍽 Saving menu...';
      }

      // If everything that was triggered is done,
      // show a summary — do NOT show stale currentDetail
      if (
        p?.gallery?.status === 'done' ||
        p?.menu?.status === 'done'
      ) {
        const parts: string[] = [];
        if (p?.gallery?.status === 'done') {
          parts.push(`📸 ${p.gallery.images ?? 0} img`);
        }
        if (p?.menu?.status === 'done') {
          parts.push(`🍽 ${p.menu.items ?? 0} menu`);
        }
        return parts.join(' · ') || 'Done';
      }

      return botScrape.currentDetail || 'Scraping...';
    })();

    const activeStage = (() => {
      // Currently scraping stages take priority
      if (p?.reviews?.status === 'scraping') return 'reviews';
      if (p?.menu?.status === 'scraping') return 'menu';
      if (p?.gallery?.status === 'scraping') return 'gallery';

      // Transition: gallery done, menu not done yet
      if (
        p?.gallery?.status === 'done' &&
        p?.menu?.status !== 'done'
      ) {
        return 'menu';
      }

      // Only show reviews transition if reviews was
      // actually started (status === 'scraping')
      if (
        p?.menu?.status === 'done' &&
        p?.reviews?.status === 'scraping'
      ) {
        return 'reviews';
      }

      // Default to currentStage from DB or gallery
      return botScrape.currentStage || 'gallery';
    })();

    const anyInProgress =
      getStageStatus(p?.gallery, 'Gallery', botScrape) === 'in_progress' ||
      getStageStatus(p?.menu, 'Menu', botScrape) === 'in_progress' ||
      getStageStatus(p?.reviews, 'Reviews', botScrape) === 'in_progress';

    // Reviews progress percentage
    let pct = 0;
    if (activeStage === 'reviews' && p?.reviews?.total) {
      pct = Math.min(
        ((p.reviews.current ?? 0) / p.reviews.total) * 100, 99,
      );
    } else if (
      p?.gallery?.status === 'done' &&
      p?.menu?.status !== 'done'
    ) {
      pct = 35;
    } else if (
      p?.menu?.status === 'done' &&
      p?.reviews?.status !== 'done'
    ) {
      pct = 65;
    }

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: '120px',
      }}>
        {/* Stage indicators */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}>
          {/* Pulsing dot — only when at least one stage is in_progress */}
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: '#D97706',
            flexShrink: 0,
            animation: anyInProgress
              ? 'pulse 1.5s infinite'
              : 'none',
          }} />
          <span style={{
            fontSize: '11px',
            color: '#D97706',
            fontWeight: 500,
          }}>
            {activeStage === 'gallery' ? '📸 Gallery' :
             activeStage === 'menu' ? '🍽 Menu' :
             activeStage === 'reviews' ? '⭐ Reviews' :
             '⟳ Scraping...'}
          </span>
        </div>

        {/* Progress bar */}
        {activeStage === 'reviews' && p?.reviews?.total ? (
          <div style={{
            width: '100%',
            height: '3px',
            backgroundColor: '#F4F4F5',
            borderRadius: '2px',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${pct}%`,
              backgroundColor: '#D97706',
              borderRadius: '2px',
              transition: 'width 0.5s ease',
            }} />
          </div>
        ) : null}

        {/* Detail text */}
        <span style={{
          fontSize: '10px',
          color: '#A1A1AA',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '160px',
        }}>
          {activeDetail}
        </span>
      </div>
    );
  }

  // pending
  return (
    <span style={{ fontSize: '12px', color: '#A1A1AA' }}>
      Pending
    </span>
  );
}

// Full detail view for expanded panel
export function BotProgressDetail({
  botScrape,
}: {
  botScrape: BotScrape | null | undefined;
}) {
  if (!botScrape) return null;

  const p = botScrape.progress;

  function StageRow({
    icon,
    label,
    stageData,
    detail,
    botScrape,
  }: {
    icon: string;
    label: string;
    stageData?: StageProgress;
    detail?: string;
    botScrape: BotScrape;
  }) {
    const status = getStageStatus(stageData, label, botScrape);
    const cfg = STATUS_CONFIG[status];

    // Compute percentage and detail text
    let pct = cfg.pct ?? 0;
    let currentDetail = detail || '';

    if (status === 'in_progress') {
      if (label === 'Reviews' && stageData?.total) {
        pct = Math.min(
          ((stageData.current || 0) / stageData.total) * 100,
          99,
        );
        if ((stageData.expanding || 0) > 0) {
          currentDetail =
            `Expanding ${stageData.expanding} reviews...`;
        } else {
          currentDetail =
            `${stageData.current || 0} / ${stageData.total} reviews`;
        }
      } else if (label === 'Gallery') {
        pct = stageData?.foldersTotal
          ? ((stageData?.folders || 0) /
             stageData.foldersTotal) * 100
          : 30;
        currentDetail = stageData?.currentFolder
          ? `Scraping: ${stageData.currentFolder}`
          : 'Opening photos...';
      } else if (label === 'Menu') {
        pct = 50;
        currentDetail = 'Reading menu...';
      }
    } else if (status === 'done') {
      if (label === 'Reviews') {
        currentDetail = `${stageData?.current ?? 0} reviews`;
      } else if (label === 'Gallery') {
        currentDetail =
          `${stageData?.folders ?? 0} folders · ` +
          `${stageData?.images ?? 0} images`;
      } else if (label === 'Menu') {
        currentDetail = `${stageData?.items ?? 0} items`;
      }
    }

    return (
      <div style={{
        padding: '10px 0',
        borderBottom: '1px solid #F4F4F5',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '6px',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <span style={{ fontSize: '14px' }}>{icon}</span>
            <span style={{
              fontSize: '13px',
              fontWeight: 500,
              color: '#0A0A0A',
            }}>
              {label}
            </span>
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}>
            {cfg.pulse && (
              <span style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: cfg.color,
                animation: 'pulse 1.5s infinite',
                display: 'inline-block',
              }} />
            )}
            <span style={{
              fontSize: '12px',
              color: cfg.color,
              fontWeight: status === 'done' ? 500 : 400,
            }}>
              {cfg.label}
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{
          width: '100%',
          height: '4px',
          backgroundColor: '#F4F4F5',
          borderRadius: '2px',
          overflow: 'hidden',
          marginBottom: '6px',
        }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            backgroundColor: cfg.barColor,
            borderRadius: '2px',
            transition: 'width 0.5s ease',
          }} />
        </div>

        {/* Detail text */}
        {currentDetail && (
          <span style={{
            fontSize: '11px',
            color: '#71717A',
          }}>
            {currentDetail}
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{
      padding: '16px',
      backgroundColor: '#FAFAFA',
      borderRadius: '8px',
      border: '1px solid #E4E4E7',
      marginTop: '12px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '12px',
      }}>
        <span style={{
          fontSize: '12px',
          fontWeight: 500,
          color: '#0A0A0A',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          Bot Scrape Progress
        </span>
        {botScrape.startedAt && (
          <span style={{
            fontSize: '11px',
            color: '#A1A1AA',
          }}>
            Started{' '}
            {new Date(botScrape.startedAt)
              .toLocaleTimeString()}
          </span>
        )}
      </div>

      <StageRow
        icon="📸"
        label="Gallery"
        stageData={p?.gallery}
        botScrape={botScrape}
      />
      <StageRow
        icon="🍽"
        label="Menu"
        stageData={p?.menu}
        botScrape={botScrape}
      />
      <StageRow
        icon="⭐"
        label="Reviews"
        stageData={p?.reviews}
        botScrape={botScrape}
      />

      {botScrape.status === 'done' &&
       botScrape.completedAt && (
        <div style={{
          marginTop: '10px',
          fontSize: '11px',
          color: '#16A34A',
          textAlign: 'center',
        }}>
          Completed at{' '}
          {new Date(botScrape.completedAt)
            .toLocaleTimeString()}
        </div>
      )}

      {botScrape.error && (
        <div style={{
          marginTop: '10px',
          fontSize: '12px',
          color: '#DC2626',
          padding: '8px',
          backgroundColor: '#FEF2F2',
          borderRadius: '6px',
        }}>
          Error: {botScrape.error}
        </div>
      )}
    </div>
  );
}
