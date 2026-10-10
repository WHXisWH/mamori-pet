import { NotificationSettings } from '@/components/NotificationSettings';
import { GuardianDeletion } from '@/components/GuardianDeletion';
import { SecondGuardianInvite } from '@/components/SecondGuardianInvite';
import { RuleCard } from '@ijime/ui';

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
      <RuleCard gradeBand="jhs" className="my-6 border border-ink/15 bg-white" />
      <NotificationSettings />
      <GuardianDeletion />
      <SecondGuardianInvite />
    </main>
  );
}
