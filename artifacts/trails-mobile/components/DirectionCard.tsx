import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface Props {
  label: string;
  rationale: string;
  isWellTrodden: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export default function DirectionCard({
  label,
  rationale,
  isWellTrodden,
  disabled,
  onPress,
}: Props) {
  const colors = useColors();

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: isWellTrodden ? colors.primary + '60' : colors.border,
          borderRadius: colors.radius,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {isWellTrodden && (
        <View
          style={[
            styles.badge,
            { backgroundColor: colors.accent, borderRadius: 6 },
          ]}
        >
          <Ionicons name="map-outline" size={11} color={colors.primary} />
          <Text style={[styles.badgeText, { color: colors.primary }]}>
            well-trodden
          </Text>
        </View>
      )}
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <Text
        style={[styles.rationale, { color: colors.mutedForeground }]}
        numberOfLines={3}
      >
        {rationale}
      </Text>
      <View style={styles.arrow}>
        <Ionicons
          name="arrow-forward-outline"
          size={16}
          color={colors.mutedForeground}
        />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 18,
    borderWidth: 1,
    gap: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 2,
  },
  badgeText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  label: { fontSize: 17, fontFamily: 'Inter_600SemiBold', letterSpacing: -0.3 },
  rationale: { fontSize: 13, lineHeight: 19 },
  arrow: { alignSelf: 'flex-end', marginTop: 4 },
});
