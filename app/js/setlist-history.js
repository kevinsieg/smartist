// Redirects to the merged Setlists page → History tab
if (typeof navigate === 'function') {
  navigate('/setlist?view=history');
} else {
  window.location.replace('/setlist?view=history');
}
