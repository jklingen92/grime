from django.contrib.auth.mixins import UserPassesTestMixin
from django.urls import reverse_lazy


class StaffRequiredMixin(UserPassesTestMixin):
    """Restrict access to active staff, redirecting to the admin login page."""
    login_url = reverse_lazy('admin:login')

    def test_func(self):
        return self.request.user.is_active and self.request.user.is_staff
