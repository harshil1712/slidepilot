<script setup lang="ts">
import { useNav } from "@slidev/client";
import { defineAsyncComponent } from "vue";

const { isPresenter } = useNav();
// Viewers don't mount or load the voice client bundle.
const SlidePilot = defineAsyncComponent(() => import("./components/SlidePilot.vue"));
</script>

<template>
  <SlidePilot v-if="isPresenter" />
</template>
