import { Redirect } from 'expo-router';

/**
 * The tabs group root always defers to the dive screen.
 */
export default function TabsIndex() {
  return <Redirect href="/dive" />;
}
