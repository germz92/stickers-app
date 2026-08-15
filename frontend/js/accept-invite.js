async function acceptInvite() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const message = document.getElementById('inviteMessage');
    const btn = document.getElementById('acceptBtn');
    const name = document.getElementById('inviteName').value.trim();
    const password = document.getElementById('invitePassword').value;
    const confirm = document.getElementById('invitePasswordConfirm').value;

    message.className = '';
    message.textContent = '';

    if (!token) {
        message.className = 'invite-error';
        message.textContent = 'Missing invite token. Open the link from your email.';
        return;
    }
    if (!password || password.length < 8) {
        message.className = 'invite-error';
        message.textContent = 'Password must be at least 8 characters.';
        return;
    }
    if (password !== confirm) {
        message.className = 'invite-error';
        message.textContent = 'Passwords do not match.';
        return;
    }

    btn.disabled = true;
    try {
        const response = await fetch(`${API_BASE_URL}/auth/accept-invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password, name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not activate account');

        localStorage.setItem('adminToken', data.token);
        localStorage.setItem('adminTokenExpiry', String(Date.now() + 24 * 60 * 60 * 1000));
        message.className = 'invite-success';
        message.textContent = 'Account activated. Redirecting to admin…';
        setTimeout(() => {
            window.location.href = '/admin.html';
        }, 800);
    } catch (error) {
        message.className = 'invite-error';
        message.textContent = error.message;
        btn.disabled = false;
    }
}

document.getElementById('invitePasswordConfirm')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') acceptInvite();
});
