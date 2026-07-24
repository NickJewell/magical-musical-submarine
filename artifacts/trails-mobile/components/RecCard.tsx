import { useState } from 'react';
import {
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { Recommendation } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

interface Props {
  rec: Recommendation;
  onRate: (
    recId: number,
    listenState: 'listened' | 'skipped' | 'known',
    score?: number | null,
  ) => Promise<void>;
}

export default function RecCard({ rec, onRate }: Props) {
  const colors = useColors();
  const [rated, setRated] = useState<string | null>(
    rec.latestRating?.listenState ?? null,
  );
  const [rating, setRating] = useState<number | null>(null);

  const handleRate = async (
    listenState: 'listened' | 'skipped' | 'known',
    score?: number | null,
  ) => {
    if (rated && rated !== 'listened') return; // allow re-rating listened
    setRated(listenState);
    if (score !== undefined) setRating(score);
    Haptics.selectionAsync();
    await onRate(rec.id, listenState, score);
  };

  const openLink = (url: string | null | undefined) => {
    if (!url) return;
    Linking.openURL(url).catch(() => {});
  };

  const links = rec.linksJson;
  const hasSpotify = !!links?.spotify;
  const hasYouTube = !!links?.youtube;
  const hasApple = !!links?.appleMusic;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: rated === 'listened' ? colors.primary + '60' : colors.border,
          borderRadius: colors.radius,
          marginHorizontal: 16,
          marginVertical: 6,
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.meta}>
          <View
            style={[
              styles.typeBadge,
              { backgroundColor: colors.accent, borderRadius: 4 },
            ]}
          >
            <Text style={[styles.typeBadgeText, { color: colors.primary }]}>
              {rec.type}
            </Text>
          </View>
          {rec.arm === 'well_trodden' && (
            <View
              style={[
                styles.typeBadge,
                { backgroundColor: colors.secondary, borderRadius: 4 },
              ]}
            >
              <Text style={[styles.typeBadgeText, { color: colors.mutedForeground }]}>
                well-trodden
              </Text>
            </View>
          )}
        </View>
        {rated && (
          <Ionicons
            name={
              rated === 'listened'
                ? 'heart'
                : rated === 'known'
                ? 'musical-notes'
                : 'close-circle'
            }
            size={18}
            color={
              rated === 'listened'
                ? colors.primary
                : rated === 'known'
                ? colors.mutedForeground
                : colors.destructive
            }
          />
        )}
      </View>

      {/* Title */}
      <Text
        style={[styles.title, { color: colors.foreground }]}
        numberOfLines={2}
      >
        {rec.title}
      </Text>
      <Text style={[styles.artist, { color: colors.mutedForeground }]}>
        {rec.artist}
        {rec.year ? ` · ${rec.year}` : ''}
      </Text>

      {/* Narrative */}
      {rec.narrativeText ? (
        <Text
          style={[styles.narrative, { color: colors.mutedForeground }]}
          numberOfLines={4}
        >
          {rec.narrativeText}
        </Text>
      ) : null}

      {/* Streaming links */}
      {(hasSpotify || hasYouTube || hasApple) && (
        <View style={styles.streamRow}>
          {hasSpotify && (
            <TouchableOpacity
              onPress={() => openLink(links?.spotify)}
              activeOpacity={0.7}
              style={[
                styles.streamBtn,
                { backgroundColor: '#1DB954', borderRadius: 20 },
              ]}
            >
              <Ionicons name="musical-note" size={14} color="#fff" />
              <Text style={[styles.streamBtnText, { color: '#fff' }]}>
                Spotify
              </Text>
            </TouchableOpacity>
          )}
          {hasYouTube && (
            <TouchableOpacity
              onPress={() => openLink(links?.youtube)}
              activeOpacity={0.7}
              style={[
                styles.streamBtn,
                { backgroundColor: '#FF0000', borderRadius: 20 },
              ]}
            >
              <Ionicons name="play" size={14} color="#fff" />
              <Text style={[styles.streamBtnText, { color: '#fff' }]}>
                YouTube
              </Text>
            </TouchableOpacity>
          )}
          {hasApple && (
            <TouchableOpacity
              onPress={() => openLink(links?.appleMusic)}
              activeOpacity={0.7}
              style={[
                styles.streamBtn,
                { backgroundColor: '#FC3C44', borderRadius: 20 },
              ]}
            >
              <Ionicons name="headset" size={14} color="#fff" />
              <Text style={[styles.streamBtnText, { color: '#fff' }]}>
                Apple
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Rating */}
      <View
        style={[styles.ratingDivider, { backgroundColor: colors.border }]}
      />
      <View style={styles.ratingRow}>
        {/* Loved */}
        <TouchableOpacity
          onPress={() => handleRate('listened', rating ?? 5)}
          activeOpacity={0.7}
          style={[
            styles.ratingBtn,
            {
              backgroundColor:
                rated === 'listened' ? colors.accent : 'transparent',
              borderRadius: 8,
            },
          ]}
        >
          <Ionicons
            name={rated === 'listened' ? 'heart' : 'heart-outline'}
            size={20}
            color={rated === 'listened' ? colors.primary : colors.mutedForeground}
          />
        </TouchableOpacity>

        {/* Score buttons (only shown if listened) */}
        {rated === 'listened' && (
          <View style={styles.scoreRow}>
            {[1, 2, 3, 4, 5].map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => handleRate('listened', s)}
                activeOpacity={0.7}
                style={[
                  styles.scoreBtn,
                  {
                    backgroundColor:
                      rating === s ? colors.primary : colors.muted,
                    borderRadius: 4,
                  },
                ]}
              >
                <Text
                  style={{
                    color: rating === s ? colors.primaryForeground : colors.mutedForeground,
                    fontSize: 11,
                    fontFamily: 'Inter_500Medium',
                  }}
                >
                  {s}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ flex: 1 }} />

        {/* Know it */}
        <TouchableOpacity
          onPress={() => handleRate('known')}
          activeOpacity={0.7}
          style={[
            styles.ratingBtn,
            {
              backgroundColor:
                rated === 'known' ? colors.secondary : 'transparent',
              borderRadius: 8,
            },
          ]}
        >
          <Ionicons
            name="musical-notes-outline"
            size={18}
            color={rated === 'known' ? colors.foreground : colors.mutedForeground}
          />
        </TouchableOpacity>

        {/* Skip */}
        <TouchableOpacity
          onPress={() => handleRate('skipped')}
          activeOpacity={0.7}
          style={[
            styles.ratingBtn,
            {
              backgroundColor:
                rated === 'skipped' ? colors.muted : 'transparent',
              borderRadius: 8,
            },
          ]}
        >
          <Ionicons
            name="close-outline"
            size={22}
            color={
              rated === 'skipped' ? colors.destructive : colors.mutedForeground
            }
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 16, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { flex: 1, flexDirection: 'row', gap: 6 },
  typeBadge: { paddingHorizontal: 6, paddingVertical: 2 },
  typeBadgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  title: { fontSize: 18, fontFamily: 'Inter_600SemiBold', letterSpacing: -0.3 },
  artist: { fontSize: 14 },
  narrative: { fontSize: 13, lineHeight: 19, fontStyle: 'italic' },
  streamRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  streamBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  streamBtnText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  ratingDivider: { height: 1, marginVertical: 2 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratingBtn: { padding: 6 },
  scoreRow: { flexDirection: 'row', gap: 4, marginLeft: 4 },
  scoreBtn: { width: 26, height: 26, justifyContent: 'center', alignItems: 'center' },
});
