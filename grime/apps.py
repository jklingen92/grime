from django.apps import AppConfig


class GrimeConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "grime"
    verbose_name = "Grime"

    def ready(self):
        from django.db.models.signals import post_migrate
        post_migrate.connect(_seed_worker_slots, sender=self)


def _seed_worker_slots(sender, **kwargs):
    from django.conf import settings
    from grime.models import WorkerSlot

    n = getattr(settings, "GRIME_WORKER_SLOTS", 3)
    for i in range(1, n + 1):
        WorkerSlot.objects.get_or_create(slot_number=i, defaults={"name": f"Worker {i}"})
