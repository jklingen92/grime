"""Create WorkerSlot rows from GRIME_WORKER_SLOTS setting."""

from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Seed WorkerSlot rows based on GRIME_WORKER_SLOTS setting (default 3)."

    def handle(self, *args, **options):
        from grime.models import WorkerSlot

        n = getattr(settings, "GRIME_WORKER_SLOTS", 3)
        created = 0
        for i in range(1, n + 1):
            _, was_created = WorkerSlot.objects.get_or_create(
                slot_number=i,
                defaults={"name": f"Worker {i}"},
            )
            if was_created:
                created += 1

        self.stdout.write(
            self.style.SUCCESS(f"Done — {created} slot(s) created, {n - created} already existed.")
        )
