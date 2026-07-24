import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import {
  getListDivesQueryOptions,
  getLoadDiveQueryOptions,
  type Dive,
  type DiveDetail,
  type DiveStep,
  type Recommendation,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useUser } from '@/context/UserContext';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function ratingIcon(
  listenState: 'listened' | 'skipped' | 'known',
): 'heart' | 'musical-notes' | 'close-circle' {
  if (listenState === 'listened') return 'heart';
  if (listenState === 'known') return 'musical-notes';
  return 'close-circle';
}

// ── Read-only rec card for history ───────────────────────────────────────────

function HistoryRecCard({ rec }: { rec: Recommendation }) {
  const colors = useColors();
  const rating = rec.latestRating;

  return (
    <View
      style={[
        hStyles.recCard,
        {
          backgroundColor: colors.card,
          borderColor: rating?.listenState === 'listened'
            ? colors.primary + '60'
            : colors.border,
          borderRadius: colors.radius,
        },
      ]}
    >
      {/* Header */}
      <View style={hStyles.recHeader}>
        <View style={hStyles.recMeta}>
          <View style={[hStyles.badge, { backgroundColor: colors.accent, borderRadius: 4 }]}>
            <Text style={[hStyles.badgeText, { color: colors.primary }]}>{rec.type}</Text>
          </View>
          {rec.arm === 'well_trodden' && (
            <View style={[hStyles.badge, { backgroundColor: colors.secondary, borderRadius: 4 }]}>
              <Text style={[hStyles.badgeText, { color: colors.mutedForeground }]}>well-trodden</Text>
            </View>
          )}
        </View>
        {rating && (
          <View style={hStyles.ratingChip}>
            <Ionicons
              name={ratingIcon(rating.listenState)}
              size={14}
              color={
                rating.listenState === 'listened'
                  ? colors.primary
                  : rating.listenState === 'known'
                  ? colors.mutedForeground
                  : colors.destructive
              }
            />
            {rating.listenState === 'listened' && rating.score != null && (
              <Text style={[hStyles.scoreText, { color: colors.mutedForeground }]}>
                {rating.score}/5
              </Text>
            )}
          </View>
        )}
      </View>

      {/* Title & artist */}
      <Text style={[hStyles.recTitle, { color: colors.foreground }]} numberOfLines={2}>
        {rec.title}
      </Text>
      <Text style={[hStyles.recArtist, { color: colors.mutedForeground }]}>
        {rec.artist}{rec.year ? ` · ${rec.year}` : ''}
      </Text>

      {/* Narrative */}
      {rec.narrativeText ? (
        <Text style={[hStyles.narrative, { color: colors.mutedForeground }]} numberOfLines={3}>
          {rec.narrativeText}
        </Text>
      ) : null}

      {/* User note — shown in italics next to the track */}
      {rec.latestRating?.reviewText ? (
        <Text style={[hStyles.userNote, { color: colors.mutedForeground }]} numberOfLines={2}>
          "{rec.latestRating.reviewText}"
        </Text>
      ) : null}
    </View>
  );
}

// ── Dive step card ────────────────────────────────────────────────────────────

function StepCard({ step }: { step: DiveStep }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(true);

  return (
    <View
      style={[
        hStyles.stepCard,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius,
        },
      ]}
    >
      {/* Step header */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setExpanded((v) => !v)}
        style={hStyles.stepHeader}
      >
        <View
          style={[
            hStyles.stepBadge,
            { backgroundColor: colors.accent, borderRadius: colors.radius / 2 },
          ]}
        >
          <Text style={[hStyles.stepBadgeText, { color: colors.primary }]}>
            step {step.seq}
          </Text>
        </View>
        {step.chosenDirection && (
          <Text
            style={[hStyles.chosenDir, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {step.chosenDirection}
          </Text>
        )}
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={colors.mutedForeground}
        />
      </TouchableOpacity>

      {expanded && (
        <>
          {/* Hypothesis */}
          {step.hypothesisText && (
            <Text style={[hStyles.hypothesis, { color: colors.mutedForeground }]}>
              {step.hypothesisText}
            </Text>
          )}

          {/* Directions */}
          {step.directionsJson && (
            <View style={hStyles.directionsBlock}>
              <Text style={[hStyles.dirLabel, { color: colors.mutedForeground }]}>
                directions
              </Text>
              {step.directionsJson.directions.map((dir) => (
                <View
                  key={dir.label}
                  style={[
                    hStyles.dirRow,
                    {
                      borderLeftColor:
                        dir.label === step.chosenDirection
                          ? colors.primary
                          : colors.border,
                    },
                  ]}
                >
                  <Text style={[hStyles.dirName, { color: colors.foreground }]}>
                    {dir.label}
                    {dir.label === step.chosenDirection && (
                      <Text style={{ color: colors.primary }}> ✓</Text>
                    )}
                  </Text>
                  <Text style={[hStyles.dirRationale, { color: colors.mutedForeground }]}>
                    {dir.rationale}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* Recommendations */}
          {step.recommendations.length > 0 && (
            <View style={hStyles.recsBlock}>
              <Text style={[hStyles.dirLabel, { color: colors.mutedForeground }]}>
                {step.recommendations.length} recommendation
                {step.recommendations.length !== 1 ? 's' : ''}
              </Text>
              {step.recommendations.map((rec) => (
                <HistoryRecCard key={rec.id} rec={rec} />
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

// ── Dive detail view ──────────────────────────────────────────────────────────

function DiveDetailView({
  diveId,
  userId,
  onBack,
  topPad,
  botPad,
}: {
  diveId: number;
  userId: number;
  onBack: () => void;
  topPad: number;
  botPad: number;
}) {
  const colors = useColors();

  const detailQuery = useQuery({
    ...getLoadDiveQueryOptions({ diveId, userId }),
    retry: false,
  });

  const dive = detailQuery.data as DiveDetail | undefined;

  return (
    <View style={[hStyles.screen, { backgroundColor: colors.background }]}>
      {/* Back bar */}
      <View
        style={[
          hStyles.backBar,
          {
            paddingTop: topPad,
            borderBottomColor: colors.border,
            backgroundColor: colors.background,
          },
        ]}
      >
        <TouchableOpacity
          onPress={onBack}
          activeOpacity={0.7}
          style={hStyles.backBtn}
        >
          <Ionicons name="chevron-back" size={20} color={colors.primary} />
          <Text style={[hStyles.backLabel, { color: colors.primary }]}>history</Text>
        </TouchableOpacity>
        {dive && (
          <Text style={[hStyles.detailTitle, { color: colors.foreground }]} numberOfLines={1}>
            {dive.name}
          </Text>
        )}
      </View>

      {/* Body */}
      {detailQuery.isPending ? (
        <View style={hStyles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : detailQuery.isError ? (
        <View style={hStyles.center}>
          <Text style={[hStyles.emptyTitle, { color: colors.foreground }]}>
            couldn't load dive
          </Text>
          <TouchableOpacity onPress={() => detailQuery.refetch()} activeOpacity={0.7}>
            <Text style={[hStyles.retryText, { color: colors.primary }]}>try again</Text>
          </TouchableOpacity>
        </View>
      ) : dive ? (
        <ScrollView
          contentContainerStyle={[
            hStyles.detailContent,
            { paddingBottom: botPad + 32 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* Dive meta */}
          <View style={hStyles.diveMeta}>
            <Text style={[hStyles.diveMetaDate, { color: colors.mutedForeground }]}>
              {formatDate(dive.createdAt)}
            </Text>
            <Text style={[hStyles.diveMetaSteps, { color: colors.mutedForeground }]}>
              {dive.steps.length} step{dive.steps.length !== 1 ? 's' : ''}
            </Text>
            <View
              style={[
                hStyles.statusChip,
                {
                  backgroundColor:
                    dive.status === 'active' ? colors.accent : colors.muted,
                  borderRadius: 4,
                },
              ]}
            >
              <Text
                style={[
                  hStyles.statusText,
                  {
                    color:
                      dive.status === 'active'
                        ? colors.primary
                        : colors.mutedForeground,
                  },
                ]}
              >
                {dive.status}
              </Text>
            </View>
          </View>

          {dive.steps.length === 0 ? (
            <View style={[hStyles.center, { paddingVertical: 40 }]}>
              <Text style={[hStyles.emptySubtitle, { color: colors.mutedForeground }]}>
                no steps yet
              </Text>
            </View>
          ) : (
            dive.steps.map((step) => <StepCard key={step.id} step={step} />)
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

// ── Dive list row ─────────────────────────────────────────────────────────────

function DiveRow({
  dive,
  onPress,
}: {
  dive: Dive;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[
        hStyles.diveRow,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius,
        },
      ]}
    >
      <View style={hStyles.diveRowLeft}>
        <Text style={[hStyles.diveName, { color: colors.foreground }]} numberOfLines={1}>
          {dive.name}
        </Text>
        <Text style={[hStyles.diveRowMeta, { color: colors.mutedForeground }]}>
          {formatDate(dive.createdAt)} · {dive.stepCount} step
          {dive.stepCount !== 1 ? 's' : ''}
        </Text>
      </View>
      <View style={hStyles.diveRowRight}>
        {dive.status === 'active' && (
          <View style={[hStyles.activeDot, { backgroundColor: colors.primary }]} />
        )}
        <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { userId } = useUser();

  const [selectedDiveId, setSelectedDiveId] = useState<number | null>(null);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const botPad = Platform.OS === 'web' ? 34 : insets.bottom;

  const listQuery = useQuery({
    ...getListDivesQueryOptions({ userId: userId ?? 0 }),
    enabled: !!userId,
    retry: false,
  });

  const dives = (listQuery.data ?? []) as Dive[];

  // ── Detail view ────────────────────────────────────────────────────────────
  if (selectedDiveId !== null && userId) {
    return (
      <DiveDetailView
        diveId={selectedDiveId}
        userId={userId}
        onBack={() => setSelectedDiveId(null)}
        topPad={topPad}
        botPad={botPad}
      />
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <View style={[hStyles.screen, { backgroundColor: colors.background }]}>
      <LinearGradient
        colors={[colors.background, '#020406']}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* Header */}
      <View
        style={[
          hStyles.listHeader,
          { paddingTop: topPad + 16, borderBottomColor: colors.border },
        ]}
      >
        <Text style={[hStyles.listTitle, { color: colors.foreground }]}>history</Text>
        {dives.length > 0 && (
          <Text style={[hStyles.listCount, { color: colors.mutedForeground }]}>
            {dives.length} dive{dives.length !== 1 ? 's' : ''}
          </Text>
        )}
      </View>

      {/* Body */}
      {listQuery.isPending ? (
        <View style={hStyles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : listQuery.isError ? (
        <View style={hStyles.center}>
          <Text style={[hStyles.emptyTitle, { color: colors.foreground }]}>
            couldn't load history
          </Text>
          <TouchableOpacity onPress={() => listQuery.refetch()} activeOpacity={0.7}>
            <Text style={[hStyles.retryText, { color: colors.primary }]}>try again</Text>
          </TouchableOpacity>
        </View>
      ) : dives.length === 0 ? (
        <View style={hStyles.center}>
          <Ionicons name="time-outline" size={52} color={colors.mutedForeground} />
          <Text style={[hStyles.emptyTitle, { color: colors.foreground }]}>
            no dives yet
          </Text>
          <Text style={[hStyles.emptySubtitle, { color: colors.mutedForeground }]}>
            start a dive to see it here
          </Text>
        </View>
      ) : (
        <FlatList
          data={dives}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={[
            hStyles.listContent,
            { paddingBottom: botPad + 32 },
          ]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={listQuery.isFetching && !listQuery.isPending}
              onRefresh={() => listQuery.refetch()}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => (
            <DiveRow dive={item} onPress={() => setSelectedDiveId(item.id)} />
          )}
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const hStyles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },

  // List
  listHeader: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  listTitle: { fontSize: 26, fontFamily: 'Inter_700Bold', letterSpacing: -0.5 },
  listCount: { fontSize: 13, marginBottom: 2 },
  listContent: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },

  // Dive row
  diveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  diveRowLeft: { flex: 1, gap: 4 },
  diveName: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  diveRowMeta: { fontSize: 13 },
  diveRowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  activeDot: { width: 7, height: 7, borderRadius: 4 },

  // Empty / error
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold' },
  emptySubtitle: { fontSize: 14, textAlign: 'center' },
  retryText: { fontSize: 14, fontFamily: 'Inter_500Medium' },

  // Detail – back bar
  backBar: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  backLabel: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  detailTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.4,
    paddingRight: 4,
  },

  // Detail – body
  detailContent: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  diveMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  diveMetaDate: { fontSize: 13 },
  diveMetaSteps: { fontSize: 13 },
  statusChip: { paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 11, fontFamily: 'Inter_500Medium' },

  // Step card
  stepCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBadge: { paddingHorizontal: 8, paddingVertical: 3 },
  stepBadgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  chosenDir: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  hypothesis: { fontSize: 13, lineHeight: 19, fontStyle: 'italic' },

  // Directions
  directionsBlock: { gap: 6 },
  dirLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  dirRow: {
    borderLeftWidth: 2,
    paddingLeft: 10,
    gap: 2,
  },
  dirName: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  dirRationale: { fontSize: 12, lineHeight: 17 },

  // Recs
  recsBlock: { gap: 8 },

  // History rec card
  recCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 6,
  },
  recHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recMeta: { flex: 1, flexDirection: 'row', gap: 6 },
  badge: { paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  ratingChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  scoreText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  recTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  recArtist: { fontSize: 13 },
  narrative: { fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  userNote: { fontSize: 12, lineHeight: 17, fontStyle: 'italic', opacity: 0.75 },
});
